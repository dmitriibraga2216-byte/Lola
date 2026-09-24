import { randomUUID } from 'node:crypto'
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { courses, libraryModuleVersions, libraryModules, mediaAssets, resources } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { ContentBlock } from '../../shared/schemas/content'
import { STORAGE_CONFIRM_PHRASE } from '../../shared/schemas/storage'
import type { MediaOrigin } from '../../shared/enums'
import { PERSON_DOCUMENT_LIMITS } from '../../shared/enums'
import { DEFAULT_TRASH_DAYS } from '../db/tenantDefaults'
import { GIB } from './tenantLimits'
import { recordUsage, syncCounter } from './usageCounters'
import { recordAudit } from './audit'
import { canStore, mediaUnderReview, storageUsedBytes } from './storage'
import { trashDaysFor } from './storagePolicies'
import { completePendingUpload, deferUpload, kickPendingUploads, linkPendingMedia, pendingByClientRef, tryGrant } from './storagePending'

/**
 * Медиа (docs/11 §3.4, Г-11.4, docs/04 §4.15): presigned PUT в S3, ключ — uuid
 * (имя файла на ключ не влияет), подписанные ссылки на чтение 10 минут.
 * Лимиты: изображение ≤ 10 МБ, документ ≤ 50 МБ, аудио ≤ 100 МБ, видео ≤ 500 МБ,
 * на ресурс суммарно ≤ 1 ГБ. Отказ — до начала передачи, с понятным текстом.
 */

export type MediaKind = 'image' | 'video' | 'audio' | 'file'

export const MEDIA_LIMITS_MB: Record<MediaKind, number> = { image: 10, file: 50, audio: 100, video: 500 }
export const RESOURCE_TOTAL_LIMIT_MB = 1024

const KIND_LABEL: Record<MediaKind, string> = { image: 'зображення', file: 'документа', audio: 'аудіо', video: 'відео' }

/** Allowlist форматов (docs/11 §3.4): jpg/jpeg/png/gif/webp/svg · mp4/mov/webm · mp3/m4a · pdf/docx/xlsx/pptx/csv/txt. */
const ALLOWED: Record<string, { kind: MediaKind, ext: string }> = {
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/png': { kind: 'image', ext: 'png' },
  'image/gif': { kind: 'image', ext: 'gif' },
  'image/webp': { kind: 'image', ext: 'webp' },
  'image/svg+xml': { kind: 'image', ext: 'svg' }, // очищается при обработке (jobs/mediaProcess → svgSanitize), оригинал перезаписывается
  'video/mp4': { kind: 'video', ext: 'mp4' },
  'video/quicktime': { kind: 'video', ext: 'mov' },
  'video/webm': { kind: 'video', ext: 'webm' },
  'audio/mpeg': { kind: 'audio', ext: 'mp3' },
  'audio/mp4': { kind: 'audio', ext: 'm4a' },
  'application/pdf': { kind: 'file', ext: 'pdf' },
  'text/csv': { kind: 'file', ext: 'csv' },
  'text/plain': { kind: 'file', ext: 'txt' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'file', ext: 'xlsx' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'file', ext: 'docx' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: 'file', ext: 'pptx' },
}

export type LimitCheck = { ok: true, kind: MediaKind } | { ok: false, code: 'mime_not_allowed' | 'too_big' | 'resource_too_big', message: string }

/** Проверка лимитов без обращения к хранилищу — чистая функция, чтобы отказ был до начала передачи. */
export function checkFileLimits(mime: string, bytes: number, resourceBytes = 0): LimitCheck {
  const rule = ALLOWED[mime]
  if (!rule) return { ok: false, code: 'mime_not_allowed', message: 'Формат не підтримується' }
  const maxMb = MEDIA_LIMITS_MB[rule.kind]
  if (bytes > maxMb * 1024 * 1024) {
    return { ok: false, code: 'too_big', message: `Файл завеликий. Максимум для ${KIND_LABEL[rule.kind]} — ${maxMb} МБ` }
  }
  if (resourceBytes + bytes > RESOURCE_TOTAL_LIMIT_MB * 1024 * 1024) {
    return { ok: false, code: 'resource_too_big', message: `Файли ресурсу разом не можуть перевищувати ${RESOURCE_TOTAL_LIMIT_MB / 1024} ГБ` }
  }
  return { ok: true, kind: rule.kind }
}

let s3Client: S3Client | undefined

export function s3(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || '',
        secretAccessKey: process.env.S3_SECRET_KEY || '',
      },
      forcePathStyle: true, // MinIO
    })
  }
  return s3Client
}

export const S3_BUCKET = () => process.env.S3_BUCKET || 'lola-media'

let bucketReady: Promise<void> | undefined
/** Бакет создаётся при первом обращении (dev/CI с чистым MinIO); на проде обычно уже есть. */
export function ensureBucket(): Promise<void> {
  bucketReady ??= (async () => {
    try { await s3().send(new HeadBucketCommand({ Bucket: S3_BUCKET() })) }
    catch {
      try { await s3().send(new CreateBucketCommand({ Bucket: S3_BUCKET() })) }
      catch (e) { bucketReady = undefined; throw e }
    }
  })()
  return bucketReady
}

interface Ctx { tenantId: string, actorId: string }

/**
 * Происхождения, которые человек загружает **себе сам** и для которых не нужен `media.upload`:
 * свой документ типа `self_upload` (docs/v2/38 §2, §7.8). Остальные — только с `media.upload`.
 */
export const SELF_SERVICE_ORIGINS: readonly MediaOrigin[] = ['person_document']

/**
 * Правила файла по происхождению поверх общих лимитов вида: документ человека — PDF, JPG
 * или PNG до 20 МБ (docs/v2/38 §6.2). Отказ — до начала передачи, как у общих лимитов.
 */
export function checkOriginRules(origin: MediaOrigin, mime: string, bytes: number): { ok: true } | { ok: false, code: 'mime_not_allowed' | 'too_big', message: string } {
  if (origin !== 'person_document') return { ok: true }
  if (!(PERSON_DOCUMENT_LIMITS.fileMimes as readonly string[]).includes(mime)) return { ok: false, code: 'mime_not_allowed', message: 'Дозволені формати: PDF, JPG, PNG' }
  if (bytes > PERSON_DOCUMENT_LIMITS.fileMaxMb * 1024 * 1024) return { ok: false, code: 'too_big', message: `Файл завеликий. Максимум для документа людини — ${PERSON_DOCUMENT_LIMITS.fileMaxMb} МБ` }
  return { ok: true }
}

/**
 * `ok: true` — выдана ссылка на загрузку. Отложенная запись (`code: 'deferred'`) — не ошибка, но и
 * не ссылка: файл остаётся на устройстве, эндпоинт отвечает `202 {deferred: true, pendingId}`.
 */
export type UploadUrlResult
  = | { ok: true, mediaId: string, uploadUrl: string, key: string, pendingId?: string }
    | { ok: false, code: 'deferred', deferred: true, pendingId: string, expiresAt: string, message: string }
    | { ok: false, code: 'mime_not_allowed' | 'too_big' | 'resource_too_big' | 'storage_limit' | 'pending_done' | 'pending_abandoned', message: string }

/**
 * Происхождения, которые загружает сам учащийся, — его собственная работа: сдача практикума,
 * видеоответ, скриншот к жалобе на материал. Для них достаточно `learn.attempt` —
 * иначе сотрудник без `media.upload` (docs/01 §1.4: у `employee` его нет) не мог бы сдать
 * практикум с фото или видео, а при исчерпанной квоте — даже отложить запись (docs/v2/34 §7.5,
 * §13 к. 1). Загрузку контента (обложки, вложения уроков) это не открывает.
 */
export const LEARNER_UPLOAD_ORIGINS: readonly MediaOrigin[] = ['workshop_submission', 'video_answer', 'issue_screenshot']

/**
 * Скільки байт уже займають файли тенанта (докс/33 D-054, docs/25 §10): жорсткий лімит
 * перевіряється по поточному значенню, не по нічному знімку `tenant_usage`. С PR-36 —
 * по оперативному счётчику `storage_usage_counters` (docs/v2/34 §7.4 п. 1): одно число на
 * экран, баннер и проверку, без второго подсчёта суммой по `media_assets`.
 */
export async function tenantStorageBytes(ctx: Ctx): Promise<number> {
  return storageUsedBytes(ctx.tenantId)
}

/** Сколько байт уже занимают файлы ресурса (основной файл + медиа в блоках) — для лимита «на ресурс ≤ 1 ГБ». */
export async function resourceBytes(ctx: Ctx, resourceId: string): Promise<number> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.select({ mediaId: resources.mediaId, body: resources.body }).from(resources).where(eq(resources.id, resourceId))
    if (!r) return 0
    const ids = [...new Set([...(r.mediaId ? [r.mediaId] : []), ...(r.body as ContentBlock[]).flatMap(b => ('mediaId' in b ? [b.mediaId] : []))])]
    if (!ids.length) return 0
    const rows = await tx.select({ bytes: mediaAssets.bytes }).from(mediaAssets).where(and(inArray(mediaAssets.id, ids), isNull(mediaAssets.deletedAt)))
    return rows.reduce((sum, m) => sum + m.bytes, 0)
  })
}

/**
 * Классификация файла, обязательная на единственном входе загрузки (docs/v2/34 §7.1,
 * решение В-17): происхождение задаётся клиентом **при выдаче presigned URL**, а не
 * вычисляется потом. Иначе остаётся путь загрузки без `origin`, контрактный тест №4 зелёный,
 * а неклассифицированные файлы копятся — ровно то, из-за чего на эталоне «Інше» 90 % объёма.
 */
export interface UploadClassification {
  origin: MediaOrigin
  sourceEntity?: string
  sourceId?: string
  courseId?: string
  enrollmentId?: string
  isEvidence?: boolean
}

/**
 * Ключ разбивки хранилища — код этапа курса (решение В-10): денормализованный снимок
 * `courses.lifecycle_stage_id → code` на момент создания файла. При смене этапа у курса
 * **не пересчитывается**: разбивка обязана быть сравнимой во времени, иначе годовой график
 * потребления переписывается задним числом. Файл вне курса ключа не получает — он попадает
 * в девятый ключ `other` уже на стороне сводки.
 */
async function stageCodeOfCourse(ctx: Ctx, courseId: string | undefined): Promise<string | null> {
  if (!courseId) return null
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.execute(sql`
      select s.code from ${courses} c join lifecycle_stages s on s.id = c.lifecycle_stage_id
       where c.id = ${courseId}::uuid
    `) as unknown as { code: string }[]
    return row?.code ?? null
  })
}

export async function createUploadUrl(ctx: Ctx, input: {
  filename: string
  mime: string
  bytes: number
  resourceId?: string
  /** Ключ записи на устройстве (OPFS/IndexedDB): с ним исчерпанная квота — не отказ, а отложенная загрузка (docs/v2/34 §7.5). */
  clientRef?: string
} & UploadClassification): Promise<UploadUrlResult> {
  const used = input.resourceId ? await resourceBytes(ctx, input.resourceId) : 0
  const check = checkFileLimits(input.mime, input.bytes, used)
  if (!check.ok) return check
  const byOrigin = checkOriginRules(input.origin, input.mime, input.bytes)
  if (!byOrigin.ok) return byOrigin

  // Досылка отложенной записи тем же входом (решение В-17): устройство повторяет запрос с тем же
  // `clientRef`. Место уже выдано (`uploading`) — квота не проверяется ещё раз: начатая загрузка
  // досылается, а не рвётся (§7.5). Файл под неё уже заведён — выдаётся новая ссылка на него же.
  const pending = input.clientRef
    ? await withTenant(ctx.tenantId, ctx.actorId, tx => pendingByClientRef(tx, ctx.actorId, input.clientRef!))
    : null
  if (pending?.status === 'done') return { ok: false, code: 'pending_done', message: 'Файл уже відправлено' }
  if (pending?.status === 'abandoned') return { ok: false, code: 'pending_abandoned', message: 'Термін очікування минув — файл не вдалося відправити' }
  if (pending?.mediaId) {
    const media = await getMedia(ctx, pending.mediaId)
    if (media && media.status === 'uploading') {
      await ensureBucket()
      const uploadUrl = await getSignedUrl(s3(), new PutObjectCommand({ Bucket: S3_BUCKET(), Key: media.key, ContentType: media.mime }), { expiresIn: 600 })
      return { ok: true, mediaId: media.id, uploadUrl, key: media.key, pendingId: pending.id }
    }
  }

  // Жорсткий ліміт диска тенанта (docs/25 §10, docs/24 §4.4; докс/33 D-054): перевіряється в момент
  // операції по поточному об'єму, а не по нічному знімку `tenant_usage`. Навчання не зупиняється —
  // блокується лише нове завантаження. Порог — `used + declared > limit + grace` (docs/v2/34 §7.5):
  // решение принимает `checkLimit()` из `tenantLimits.ts`, лимит и допуск считает только он —
  // «+100 ГБ» опцией видна здесь так же, как в баннере и в расчёте счёта (docs/v2/35 §7.3, В-5).
  if (pending?.status !== 'uploading') {
    const quota = await canStore(ctx.tenantId, input.bytes)
    if (!quota.ok) {
      await syncCounter(ctx.tenantId, 'storage_bytes', quota.used).catch(() => null)
      // Запись есть на устройстве — сдача не теряется: строка ожидания, досылка по мере места (§7.5)
      if (input.clientRef) {
        const row = await deferUpload(ctx, {
          clientRef: input.clientRef, origin: input.origin, sourceEntity: input.sourceEntity, sourceId: input.sourceId,
          enrollmentId: input.enrollmentId, bytes: input.bytes,
        })
        return { ok: false, code: 'deferred', deferred: true, pendingId: row.id, expiresAt: row.expiresAt, message: 'Сховище компанії заповнене. Запис збережеться на пристрої й відправиться автоматично' }
      }
      // Ось жёсткая: отклоняется загрузка нового файла, загруженное доступно (docs/v2/35
      // §7.1). Задание при этом можно сдать текстом — обучение не останавливается (§12).
      const limitGb = quota.limit == null ? 0 : quota.limit / GIB
      return { ok: false, code: 'storage_limit', message: `Ліміт дискового простору (${limitGb.toFixed(0)} ГБ) вичерпано. Зверніться до адміністратора` }
    }
  }

  const now = new Date()
  const key = `t/${ctx.tenantId}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${randomUUID()}.${ALLOWED[input.mime]!.ext}`

  const stageCode = await stageCodeOfCourse(ctx, input.courseId)

  const created = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    // Место есть — отложенная запись получает его сейчас, не дожидаясь задачи (§7.5 п. 3)
    if (pending?.status === 'waiting' && !await tryGrant(tx, ctx.tenantId, pending)) return null
    const [row] = await tx.insert(mediaAssets).values({
      tenantId: ctx.tenantId,
      key,
      originalName: input.filename,
      kind: check.kind,
      mime: input.mime,
      bytes: input.bytes,
      status: 'uploading',
      // Владелец — субъект файла (docs/v2/34 §7.1). Сегодня это загрузивший; как только
      // рекрутер загрузит резюме кандидата, владельцем станет кандидат, а «кто загрузил»
      // останется в audit_log ниже — колонки под второй факт больше нет (В-4).
      ownerUserId: ctx.actorId,
      origin: input.origin,
      sourceEntity: input.sourceEntity ?? null,
      sourceId: input.sourceId ?? null,
      courseId: input.courseId ?? null,
      stageCode,
      enrollmentId: input.enrollmentId ?? null,
      isEvidence: input.isEvidence ?? false,
    }).returning({ id: mediaAssets.id })
    if (pending) await linkPendingMedia(tx, pending.id, row!.id)

    // Событие `media.upload` — тот самый второй факт, ради которого переименование колонки
    // безопасно (В-4). До этого PR `media.ts` не писал аудит ни разу: файл появлялся
    // в тенанте без следа. `request_context` (ip, geo, user_agent) recordAudit пишет сам —
    // CLAUDE.md п. 14 выполняется без отдельной работы.
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'media.upload',
      entity: 'media_assets',
      entityId: row!.id,
      after: { origin: input.origin, bytes: input.bytes, mime: input.mime, ownerUserId: ctx.actorId, stageCode, ...(pending ? { pendingId: pending.id } : {}) },
    })
    return row!.id
  })
  // Место между проверкой и выдачей заняли — запись остаётся ждать (гонка двух загрузок)
  if (!created && pending) return { ok: false, code: 'deferred', deferred: true, pendingId: pending.id, expiresAt: pending.expiresAt, message: 'Сховище компанії заповнене. Запис збережеться на пристрої й відправиться автоматично' }
  const mediaId = created!

  // Счётчик пополняется в той же точке, где ось проверена (docs/v2/45 PR-09): строка расхода
  // `upload` в `usage_events` и `used += bytes` в счётчике периода. Отдельной формулы квоты
  // здесь нет — лимит уже спросили у `checkLimit()` выше.
  await recordUsage(ctx.tenantId, 'storage_bytes', input.bytes, {
    refKind: 'upload', refId: mediaId, actorUserId: ctx.actorId, meta: { mime: input.mime },
  }).catch(() => null)

  await ensureBucket()
  const uploadUrl = await getSignedUrl(s3(), new PutObjectCommand({
    Bucket: S3_BUCKET(),
    Key: key,
    ContentType: input.mime,
  }), { expiresIn: 600 })

  return { ok: true, mediaId, uploadUrl, key, ...(pending ? { pendingId: pending.id } : {}) }
}

/**
 * Подтверждение загрузки: файл в хранилище, ставим обработку. Файл отложенной записи
 * (docs/v2/34 §7.5 п. 3) закрывает свою строку ожидания в той же транзакции: сдача получает
 * настоящий файл вместо обещания и уходит ментору.
 *
 * `ownOnly` — учащийся без `media.upload` подтверждает только свой файл (`LEARNER_UPLOAD_ORIGINS`).
 */
export async function completeUpload(ctx: Ctx, mediaId: string, opts: { ownOnly?: boolean } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.update(mediaAssets)
      .set({ status: 'processing', updatedAt: new Date() })
      .where(opts.ownOnly ? and(eq(mediaAssets.id, mediaId), eq(mediaAssets.ownerUserId, ctx.actorId)) : eq(mediaAssets.id, mediaId))
      .returning()
    if (row) await completePendingUpload(tx, ctx.tenantId, row.id)
    return row ?? null
  })
}

export async function getMedia(ctx: Ctx, mediaId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.select().from(mediaAssets).where(eq(mediaAssets.id, mediaId))
    return row ?? null
  })
}

/**
 * Подписанная ссылка на чтение, 10 минут (docs/06 §6.2). SVG (D-011) отдаётся как вложение
 * с явным типом: файл уже очищен при обработке, а `attachment` не даёт открыть его как страницу
 * по прямой ссылке; в `<img src>` вложение показывается как обычно.
 *
 * Для файла-доказательства срок — **120 секунд** (решение В-19): журнал фиксирует не
 * скачивание, а выдачу ссылки, и короткий срок нужен ровно затем, чтобы расхождение между
 * «выдана» и «скачана» было минимальным. Больше от журнала честно требовать нельзя.
 */
export const EVIDENCE_URL_TTL_SEC = 120
export const DEFAULT_URL_TTL_SEC = 600

export async function signedReadUrl(key: string, isEvidence = false): Promise<string> {
  const svg = /\.svg$/i.test(key)
  return getSignedUrl(s3(), new GetObjectCommand({
    Bucket: S3_BUCKET(),
    Key: key,
    ...(svg ? { ResponseContentType: 'image/svg+xml', ResponseContentDisposition: 'attachment' } : {}),
  }), { expiresIn: isEvidence ? EVIDENCE_URL_TTL_SEC : DEFAULT_URL_TTL_SEC })
}

/**
 * Журнал обращения к файлу-доказательству (решение В-19, `34` §9).
 *
 * Пишется **только** для `is_evidence = true`. Обложка курса и вложение урока скачиваются
 * при каждом открытии урока: журналировать их — значит удвоить `audit_log` и утопить в шуме
 * то, ради чего журнал заводится («кто снёс доказательства за прошлый квартал»). Файл же,
 * на который опирается кадровое решение, обязан иметь след обращения — того же класса, что
 * `GET /people/:id/notes`.
 *
 * Заодно обновляется `last_accessed_at`: политика хранения для неклассифицированного файла
 * отсчитывается именно от него (`34` §7.3).
 */
export async function noteMediaAccess(ctx: Ctx, media: { id: string, origin: string, isEvidence: boolean }): Promise<void> {
  await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    await tx.update(mediaAssets).set({ lastAccessedAt: new Date() }).where(eq(mediaAssets.id, media.id))
    if (!media.isEvidence) return
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'media.download',
      entity: 'media_assets',
      entityId: media.id,
      after: { origin: media.origin, isEvidence: media.isEvidence },
    })
  })
}

/**
 * Срок корзины по умолчанию (`34` §4, §7.2.3). С PR-36 действующее значение живёт строкой
 * `storage_retention_policies.trash_days` (docs/v2/44 §8) — константа только умолчание посева.
 */
export const PURGE_AFTER_DAYS = DEFAULT_TRASH_DAYS

/** Слово подтверждения удаления доказательства (`34` §6.1) — украинский интерфейс. */
export const CONFIRM_DELETE_PHRASE = STORAGE_CONFIRM_PHRASE

export type DeleteMediaResult
  = | { ok: true, lifecycle: 'pending_delete', purgeAfter: Date }
    | { ok: false, code: 'not_found' }
    | { ok: false, code: 'file_not_deletable' | 'evidence_locked' | 'already_deleted' | 'under_review', message: string }
    | { ok: false, code: 'in_library_version', message: string, versions: { libraryModuleId: string, title: string, version: number }[] }

/**
 * Мягкое удаление файла — `DELETE /media/:id`, **единственная** одиночная ручка удаления
 * (решение В-17: `DELETE /storage/files/:id` из `34` §10 отменён как второе имя того же,
 * массовое удаление — только заявкой с подсчётом доказательств).
 *
 * Объект в S3 **не трогается**: ставится `lifecycle='pending_delete'`, `deleted_at`,
 * `deleted_by`, `delete_reason` и `purge_after = now() + trash_days`, восстановление — в один
 * клик. Срок корзины — строка политики хранения этого происхождения (`44` §8: предварительно
 * 30 дней, меняется без релиза). В `purged` переводит только задача `storage.purge` (PR-36).
 *
 * Счётчик уменьшается **в момент мягкого удаления**, а не при purge (`34` §7.2.3): тенант
 * платит за то, чем распоряжается, корзина не держит квоту заложником. Двигает его триггер
 * `storage_counter_apply` в той же транзакции; второй формулы квоты здесь нет.
 *
 * Файл сдачи, которую сейчас проверяют или дорабатывают, — `409 under_review` (`34` §12).
 */
export async function softDeleteMedia(ctx: Ctx, mediaId: string, input: { reason?: string, confirmPhrase?: string } = {}): Promise<DeleteMediaResult> {
  const result = await withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<DeleteMediaResult> => {
    const [row] = await tx.select().from(mediaAssets).where(eq(mediaAssets.id, mediaId))
    if (!row) return { ok: false, code: 'not_found' } // чужой тенант — 404, не 403 (CLAUDE.md п. 15)
    if (row.deletedAt) return { ok: false, code: 'already_deleted', message: 'Файл вже видалено' }

    // Запрещено вовсе (`34` §7.2.1): сертификат — выданный документ, он не удаляется никогда.
    if (row.origin === 'certificate') {
      return { ok: false, code: 'file_not_deletable', message: 'Сертифікат видалити не можна' }
    }
    // Ментор прямо сейчас ставит оценку по этому файлу (`34` §12) — сначала решение, потом удаление
    if ((await mediaUnderReview(tx, [row.id])).has(row.id)) {
      return { ok: false, code: 'under_review', message: 'Роботу з цим файлом зараз перевіряють. Видаліть після рішення наставника' }
    }
    // Доказательство — только с причиной и словом «ВИДАЛИТИ» (`34` §6.1, §7.2.2). Поднять
    // ограничение может только заявка на массовое удаление, у которой есть свой подсчёт.
    if (row.isEvidence && (!input.reason?.trim() || input.confirmPhrase !== CONFIRM_DELETE_PHRASE)) {
      return { ok: false, code: 'evidence_locked', message: `Це доказ проходження. Вкажіть причину та введіть «${CONFIRM_DELETE_PHRASE}»` }
    }
    // docs/v2/31 §7.13: файл, который держит хоть одна опубликованная версия модуля библиотеки
    // (а не только последняя), не удаляется — на старой версии ещё доучиваются (Р-31.2)
    const held = await tx.select({ libraryModuleId: libraryModules.id, title: libraryModules.title, version: libraryModuleVersions.version })
      .from(libraryModuleVersions)
      .innerJoin(libraryModules, eq(libraryModules.id, libraryModuleVersions.libraryModuleId))
      .where(sql`${mediaId}::uuid = any(${libraryModuleVersions.mediaIds})`)
      .orderBy(libraryModules.title, libraryModuleVersions.version)
      .limit(50)
    if (held.length) {
      return { ok: false, code: 'in_library_version', message: 'Файл використовується у версіях модулів бібліотеки — спершу опублікуйте версії без нього', versions: held }
    }

    const deletedAt = new Date()
    const trashDays = await trashDaysFor(tx, ctx.tenantId, row.origin)
    const purgeAfter = new Date(deletedAt.getTime() + trashDays * 24 * 60 * 60 * 1000)
    await tx.update(mediaAssets).set({
      lifecycle: 'pending_delete',
      deletedAt,
      deletedBy: ctx.actorId,
      deleteReason: input.reason?.trim() || null,
      purgeAfter,
      updatedAt: deletedAt,
    }).where(eq(mediaAssets.id, mediaId))

    // `34` §9: журнал удалений — ответ на вопрос «кто снёс доказательства за прошлый
    // квартал», поэтому before — вся строка, после — что стало (В-17: запись обязательна).
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'media.delete',
      entity: 'media_assets',
      entityId: mediaId,
      before: row,
      after: { lifecycle: 'pending_delete', deletedAt, deleteReason: input.reason?.trim() || null, purgeAfter, isEvidence: row.isEvidence },
    })
    return { ok: true, lifecycle: 'pending_delete', purgeAfter }
  })

  if (result.ok) {
    await syncCounter(ctx.tenantId, 'storage_bytes', await tenantStorageBytes(ctx)).catch(() => null)
    // Место освободилось — отложенные записи сотрудников досылаются сразу, не через 15 минут (§7.5)
    await kickPendingUploads(ctx.tenantId)
  }
  return result
}
