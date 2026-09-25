import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { platformAudit } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { keysetAfter, keysetAt } from '../utils/keyset'
import { KEYSETS, encodeKeyset } from '../../shared/domain/keyset'
import { LIFECYCLE_STAGE_CODES, MEDIA_ORIGINS, STORAGE_OTHER_KEY } from '../../shared/enums'
import type { MediaOrigin, StorageSkipReason } from '../../shared/enums'
import type { StorageFilesQuery } from '../../shared/schemas/storage'
import { checkLimit, effectiveLimit, graceOf } from './tenantLimits'
import type { LimitCheck } from './tenantLimits'
import { recordAudit } from './audit'
import { EMPLOYEES_ONLY } from './repo/people'
import { DEFAULT_TRASH_DAYS } from '../db/tenantDefaults'

/**
 * Хранилище как управляемый ресурс (docs/v2/34-storage.md; план docs/v2/45 PR-36).
 *
 * **Два числа и два владельца.** Сколько занято — отвечает этот модуль, и только по
 * оперативному счётчику `storage_usage_counters` (§7.4 п. 1: «экран и проверка квоты читают
 * только его»). Сколько можно — отвечает `effectiveLimits()` из `tenantLimits.ts`
 * (решение docs/v2/44 В-5, риск Р-6): тариф + переопределение оператора + опция
 * `storage_pack`, и допуск для начатых загрузок `graceOf()` там же. Второй формулы квоты здесь
 * нет ни одной — сводка, баннер, проверка загрузки и счёт получают лимит из одной функции.
 *
 * Разбивка «За етапом» (решение В-10) — девять ключей: восемь кодов справочника этапов и
 * `other`. Ключи берутся из `LIFECYCLE_STAGE_CODES`, подписи — из справочника тенанта
 * `lifecycle_stages`; ветвления по коду этапа нет (правило 16).
 */

export interface Ctx { tenantId: string, actorId: string }

// ── Факт: сколько занято ────────────────────────────────────────────────────────────────

const COUNTED = sql`('active', 'orphaned')` // MEDIA_COUNTED_LIFECYCLES — тот же список, что в триггере

/**
 * Массив-параметр для `= any(...)`. Drizzle разворачивает JS-массив в `($1, $2)` — кортеж, а
 * не массив, — поэтому массив собирается явно; пустой — литералом.
 */
export function textArray(values: readonly string[]) {
  return values.length ? sql`array[${sql.join(values.map(v => sql`${v}`), sql`, `)}]::text[]` : sql`'{}'::text[]`
}

/** Занято байт по оперативному счётчику (§7.4 п. 1). Единственный источник «used» для экрана, баннера и проверки. */
export async function storageUsedBytes(tenantId: string, tx?: TenantTx): Promise<number> {
  const run = async (t: TenantTx) => {
    const [r] = await t.execute(sql`select coalesce(sum(bytes), 0)::bigint as n from storage_usage_counters`) as unknown as { n: string | number }[]
    return Number(r?.n ?? 0)
  }
  return tx ? run(tx) : withTenant(tenantId, null, run)
}

/** Полный пересчёт по определению §7.4 п. 3 — для ночной сверки: засчитываются `active` и `orphaned`. */
export async function storageFactBytes(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const [r] = await tx.execute(sql`select coalesce(sum(bytes), 0)::bigint as n from media_assets where lifecycle in ${COUNTED}`) as unknown as { n: string | number }[]
    return Number(r?.n ?? 0)
  })
}

// ── Квота ───────────────────────────────────────────────────────────────────────────────

export type QuotaTone = 'teal' | 'sun' | 'coral'

export interface StorageQuota {
  usedBytes: number
  /** Эффективный лимит оси `storage_bytes` — из `effectiveLimits()`; `null` = «без обмежень». */
  limitBytes: number | null
  /** Допуск для начатых загрузок (§7.5) — из `graceOf()` рядом с формулой лимита. */
  graceBytes: number
  pct: number | null
  /** Цвет полосы §5.1: бирюза до 80 %, солнце 80–95 %, коралл выше 95 %. */
  tone: QuotaTone
  /** Загрузки блокируются (жёсткий порог `used > limit + grace`); обучение — нет. */
  blocked: boolean
}

export function quotaTone(pct: number | null): QuotaTone {
  if (pct == null || pct < 80) return 'teal'
  return pct <= 95 ? 'sun' : 'coral'
}

export async function storageQuota(tenantId: string): Promise<StorageQuota> {
  const usedBytes = await storageUsedBytes(tenantId)
  const limitBytes = await effectiveLimit(tenantId, 'storage_bytes')
  const graceBytes = graceOf('storage_bytes', limitBytes)
  const pct = limitBytes == null || limitBytes <= 0 ? null : Math.round(usedBytes / limitBytes * 1000) / 10
  return { usedBytes, limitBytes, graceBytes, pct, tone: quotaTone(pct), blocked: limitBytes != null && usedBytes >= limitBytes + graceBytes }
}

/**
 * Пройдёт ли загрузка `declaredBytes` (жёсткий порог §7.5: `used + declared > limit + grace`).
 * Решение принимает `checkLimit()` из `tenantLimits.ts` — здесь только факт.
 */
export async function canStore(tenantId: string, declaredBytes: number): Promise<LimitCheck> {
  return checkLimit(tenantId, 'storage_bytes', await storageUsedBytes(tenantId), declaredBytes, { withGrace: true })
}

// ── Сводка ──────────────────────────────────────────────────────────────────────────────

export type StorageGroupBy = 'origin' | 'stage'

export interface StorageBreakdownRow {
  /** Код происхождения или ключ этапа (`LIFECYCLE_STAGE_CODES` + `other`). */
  key: string
  /** Подпись этапа из справочника тенанта (`lifecycle_stages.name_uk`); у происхождения — `null`, подпись из словаря. */
  label: string | null
  bytes: number
  filesCount: number
}

export interface StorageSummary extends StorageQuota {
  groupBy: StorageGroupBy
  breakdown: StorageBreakdownRow[]
  /** Доля `origin='other'` в объёме (§7.1: больше 5 % — дефект классификации). */
  otherShare: number
  /** Файлов, которые не удалось классифицировать (`other`), — строка «Не вдалося класифікувати». */
  otherFiles: number
  /** Когда счётчик менялся последний раз («Оновлено щойно»). */
  updatedAt: string | null
  /** Дата последнего суточного среза — «Дані для рахунку зібрано {дата}» (§5.1, §7.4). */
  collectedAt: string | null
  /** Расхождение счётчика с пересчётом в последнем срезе (`34` §9: видно admin и оператору). */
  driftBytes: number | null
  trash: { files: number, bytes: number }
  pending: { files: number, bytes: number }
  /** Подписи девяти ключей из справочника этапов тенанта (тенант правит подписи, но не ключи, В-10). */
  stageLabels: Record<string, string>
  /** Срок корзины (docs/v2/44 §8) — наименьший по политикам: «можна відновити протягом N днів». */
  trashDays: number
}

/** Порог доли «Інше», выше которого классификация считается дефектной (§7.1). */
export const OTHER_SHARE_LIMIT = 0.05

/** Происхождение «не отнесено» — значение перечня `origin`, а не ключ разбивки по этапам. */
const UNCLASSIFIED: MediaOrigin = 'other'
/** Документ человека (docs/v2/38): в реестре хранилища без имени файла. */
const PERSON_DOCUMENT: MediaOrigin = 'person_document'

export async function storageSummary(ctx: Ctx, groupBy: StorageGroupBy = 'origin'): Promise<StorageSummary> {
  const quota = await storageQuota(ctx.tenantId)
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const counters = await tx.execute(sql`
      select origin, stage_code, bytes::bigint as bytes, files_count, updated_at from storage_usage_counters
    `) as unknown as { origin: string, stage_code: string | null, bytes: string | number, files_count: number, updated_at: Date | string }[]
    const total = counters.reduce((s, c) => s + Number(c.bytes), 0)
    const other = counters.filter(c => c.origin === UNCLASSIFIED)
    const otherBytes = other.reduce((s, c) => s + Number(c.bytes), 0)
    const otherFiles = other.reduce((s, c) => s + c.files_count, 0)
    const updatedAt = counters.reduce<string | null>((max, c) => {
      const iso = new Date(c.updated_at).toISOString()
      return !max || iso > max ? iso : max
    }, null)

    // Справочник этапов тенанта — источник подписей (тенант правит подписи, но не ключи, В-10)
    const stages = await tx.execute(sql`select code, name_uk, sort from lifecycle_stages order by sort`) as unknown as { code: string, name_uk: string, sort: number }[]
    const labels = new Map(stages.map(s => [s.code, s.name_uk]))

    let breakdown: StorageBreakdownRow[]
    if (groupBy === 'stage') {
      const byKey = new Map<string, { bytes: number, files: number }>()
      for (const c of counters) {
        const key = c.stage_code ?? STORAGE_OTHER_KEY
        const cur = byKey.get(key) ?? { bytes: 0, files: 0 }
        byKey.set(key, { bytes: cur.bytes + Number(c.bytes), files: cur.files + c.files_count })
      }
      breakdown = [...LIFECYCLE_STAGE_CODES, STORAGE_OTHER_KEY].map(key => ({
        key,
        label: labels.get(key) ?? null,
        bytes: byKey.get(key)?.bytes ?? 0,
        filesCount: byKey.get(key)?.files ?? 0,
      }))
    }
    else {
      const byOrigin = new Map<string, { bytes: number, files: number }>()
      for (const c of counters) {
        const cur = byOrigin.get(c.origin) ?? { bytes: 0, files: 0 }
        byOrigin.set(c.origin, { bytes: cur.bytes + Number(c.bytes), files: cur.files + c.files_count })
      }
      breakdown = MEDIA_ORIGINS
        .map(key => ({ key, label: null, bytes: byOrigin.get(key)?.bytes ?? 0, filesCount: byOrigin.get(key)?.files ?? 0 }))
        .filter(r => r.filesCount > 0 || r.bytes > 0)
    }
    // Горизонтальные бары по убыванию (§5.1)
    breakdown.sort((a, b) => b.bytes - a.bytes)

    const [daily] = await tx.execute(sql`
      select max(day)::text as day, max(collected_at) as collected_at,
             sum(drift_bytes) filter (where day = (select max(day) from storage_usage_daily))::bigint as drift
        from storage_usage_daily
    `) as unknown as { day: string | null, collected_at: Date | string | null, drift: string | number | null }[]
    const [trash] = await tx.execute(sql`
      select count(*)::int as files, coalesce(sum(bytes), 0)::bigint as bytes from media_assets where lifecycle = 'pending_delete'
    `) as unknown as { files: number, bytes: string | number }[]
    const [pending] = await tx.execute(sql`
      select count(*)::int as files, coalesce(sum(declared_bytes), 0)::bigint as bytes
        from storage_pending_uploads where status in ('waiting', 'uploading')
    `) as unknown as { files: number, bytes: string | number }[]
    const [trashDays] = await tx.execute(sql`select min(trash_days)::int as days from storage_retention_policies`) as unknown as { days: number | null }[]

    return {
      ...quota,
      groupBy,
      breakdown,
      otherShare: total > 0 ? otherBytes / total : 0,
      otherFiles,
      updatedAt,
      collectedAt: daily?.collected_at ? new Date(daily.collected_at).toISOString() : null,
      driftBytes: daily?.day ? Number(daily.drift ?? 0) : null,
      trash: { files: trash?.files ?? 0, bytes: Number(trash?.bytes ?? 0) },
      pending: { files: pending?.files ?? 0, bytes: Number(pending?.bytes ?? 0) },
      stageLabels: Object.fromEntries(LIFECYCLE_STAGE_CODES.filter(c => labels.has(c)).map(c => [c, labels.get(c)!])),
      trashDays: trashDays?.days ?? DEFAULT_TRASH_DAYS,
    }
  })
}

// ── Реестр файлов ───────────────────────────────────────────────────────────────────────

export interface StorageFileRow {
  id: string
  originalName: string
  kind: string
  mime: string
  bytes: number
  origin: MediaOrigin
  stageCode: string | null
  isEvidence: boolean
  lifecycle: string
  status: string
  createdAt: string
  ownerUserId: string | null
  ownerName: string | null
  courseId: string | null
  courseTitle: string | null
  deletedAt: string | null
  deletedByName: string | null
  deleteReason: string | null
  purgeAfter: string | null
  /** Почему файл нельзя удалить сейчас (§7.2 п. 1); `null` — можно. */
  notDeletable: StorageSkipReason | null
}

/**
 * Файлы, на которые сейчас опирается идущая проверка: сдача на проверке или на доработке
 * (`34` §7.2 п. 1, §12 — «ментор прямо сейчас ставит оценку»). Удалять их нельзя до решения.
 */
export async function mediaUnderReview(tx: TenantTx, mediaIds: string[]): Promise<Set<string>> {
  if (!mediaIds.length) return new Set()
  const rows = await tx.execute(sql`
    select distinct r #>> '{}' as media_id
      from workshop_submissions s, jsonb_path_query(s.files, 'lax $[*].mediaId') r
     where s.status in ('submitted', 'in_review', 'rework')
       and (r #>> '{}') = any(${textArray(mediaIds)})
  `) as unknown as { media_id: string }[]
  return new Set(rows.map(r => r.media_id))
}

/**
 * Файлы, которые держит опубликованная версия модуля библиотеки (docs/v2/31 §7.13, PR-25): на
 * старой версии ещё доучиваются, поэтому ни одиночное удаление (`409 media.in_library_version`),
 * ни заявка их не удаляют — заявка пропускает с `not_deletable`.
 */
export async function mediaHeldByLibrary(tx: TenantTx, mediaIds: string[]): Promise<Set<string>> {
  if (!mediaIds.length) return new Set()
  const rows = await tx.execute(sql`
    select distinct m::text as media_id
      from library_module_versions v, unnest(v.media_ids) m
     where m::text = any(${textArray(mediaIds)})
  `) as unknown as { media_id: string }[]
  return new Set(rows.map(r => r.media_id))
}

/**
 * Почему файл нельзя удалить (§7.2 п. 1, §13 к. 4). Сертификат — выданный документ, он не
 * удаляется никогда; файл версии модуля библиотеки — пока на ней учатся; сдача на проверке —
 * до решения. Доказательство удалить **можно**, но только с причиной и словом «ВИДАЛИТИ» —
 * это не запрет, а подтверждение (§7.2 п. 2).
 */
export function notDeletableReason(row: { origin: string }, underReview: boolean, heldByLibrary = false): StorageSkipReason | null {
  if (row.origin === 'certificate' || heldByLibrary) return 'not_deletable'
  if (underReview) return 'under_review'
  return null
}

const DEFAULT_PAGE = 50

/** Условие выборки реестра по фильтрам экрана (§5.1): общий для списка и заявки «по фильтру». */
export function filesWhere(q: Partial<StorageFilesQuery>): ReturnType<typeof sql> {
  const conds = [sql`true`]
  const status = q.status ?? 'active'
  if (status === 'trash') conds.push(sql`m.lifecycle = 'pending_delete'`)
  else if (status === 'orphaned') conds.push(sql`m.lifecycle = 'orphaned'`)
  else if (status === 'failed') conds.push(sql`m.lifecycle in ${COUNTED} and m.status = 'failed'`)
  else if (status === 'purged') conds.push(sql`m.lifecycle = 'purged'`)
  else conds.push(sql`m.lifecycle = 'active'`)
  if (q.origin?.length) conds.push(sql`m.origin = any(${textArray(q.origin)})`)
  if (q.stage) conds.push(q.stage === STORAGE_OTHER_KEY ? sql`m.stage_code is null` : sql`m.stage_code = ${q.stage}`)
  if (q.categoryId) conds.push(sql`exists (select 1 from courses c2 where c2.id = m.course_id and c2.category_id = ${q.categoryId}::uuid)`)
  if (q.courseId) conds.push(sql`m.course_id = ${q.courseId}::uuid`)
  if (q.userId) conds.push(sql`m.owner_user_id = ${q.userId}::uuid`)
  if (q.from) conds.push(sql`m.created_at >= ${q.from}::date`)
  if (q.to) conds.push(sql`m.created_at < (${q.to}::date + 1)`)
  if (q.evidenceOnly) conds.push(sql`m.is_evidence`)
  return sql.join(conds, sql` and `)
}

/**
 * Реестр файлов (`GET /storage/files`, `/storage/trash`, §5.1, §5.2): курсор по 50, лимит 100.
 * Курсор — общий ключевой (`KEYSETS.storageFiles`, docs/04-api.md §4.1): момент читается из
 * базы текстом с микросекундами и сравнивается в SQL, ни разу не проходя через JS `Date`.
 */
export async function listStorageFiles(ctx: Ctx, q: StorageFilesQuery): Promise<{ items: StorageFileRow[], nextCursor: string | null }> {
  const limit = Math.min(q.limit ?? DEFAULT_PAGE, 100)
  const trash = q.status === 'trash'
  // Корзину удобнее читать по дате удаления («Буде очищено» — обратный отсчёт), реестр — по дате создания
  const sortCol = trash ? sql`m.deleted_at` : sql`m.created_at`
  const after = keysetAfter(KEYSETS.storageFiles, q.cursor, [sortCol, sql`m.id`], 'desc')

  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select m.id, m.original_name, m.kind, m.mime, m.bytes, m.origin, m.stage_code, m.is_evidence, m.lifecycle, m.status,
             m.created_at, m.owner_user_id, ou.full_name as owner_name, m.course_id, c.title as course_title,
             m.deleted_at, du.full_name as deleted_by_name, m.delete_reason, m.purge_after,
             ${keysetAt(sortCol)} as sort_at
        from media_assets m
        left join users ou on ou.id = m.owner_user_id
        left join users du on du.id = m.deleted_by
        left join courses c on c.id = m.course_id
       where ${filesWhere(q)} ${after ? sql`and ${after}` : sql``}
       order by ${sortCol} desc, m.id desc
       limit ${limit + 1}
    `) as unknown as {
      id: string, original_name: string, kind: string, mime: string, bytes: number, origin: MediaOrigin, stage_code: string | null
      is_evidence: boolean, lifecycle: string, status: string, created_at: Date | string, owner_user_id: string | null
      owner_name: string | null, course_id: string | null, course_title: string | null, deleted_at: Date | string | null
      deleted_by_name: string | null, delete_reason: string | null, purge_after: Date | string | null, sort_at: string
    }[]
    const page = rows.slice(0, limit)
    const underReview = await mediaUnderReview(tx, page.map(r => r.id))
    const held = await mediaHeldByLibrary(tx, page.map(r => r.id))
    const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null)
    const items: StorageFileRow[] = page.map(r => ({
      id: r.id,
      // Документ человека (docs/v2/38 §2, PR-32) место занимает как любой файл, но его имя
      // («Паспорт_…pdf») — уже персональные данные: реестр хранилища его не показывает, как и
      // `GET /media/:id` не отдаёт сам файл. Размер, дата и владелец остаются — для квоты.
      originalName: r.origin === PERSON_DOCUMENT ? '' : r.original_name,
      kind: r.kind,
      mime: r.mime,
      bytes: Number(r.bytes),
      origin: r.origin,
      stageCode: r.stage_code,
      isEvidence: r.is_evidence,
      lifecycle: r.lifecycle,
      status: r.status,
      createdAt: iso(r.created_at)!,
      ownerUserId: r.owner_user_id,
      ownerName: r.owner_name,
      courseId: r.course_id,
      courseTitle: r.course_title,
      deletedAt: iso(r.deleted_at),
      deletedByName: r.deleted_by_name,
      deleteReason: r.delete_reason,
      purgeAfter: iso(r.purge_after),
      notDeletable: notDeletableReason(r, underReview.has(r.id), held.has(r.id)),
    }))
    const last = page[page.length - 1]
    return { items, nextCursor: rows.length > limit && last ? encodeKeyset(KEYSETS.storageFiles, [last.sort_at, last.id]) : null }
  })
}

// ── Восстановление из корзины ───────────────────────────────────────────────────────────

export type RestoreResult
  = | { ok: true, lifecycle: 'active' }
    | { ok: false, code: 'not_found' | 'already_purged' | 'not_deleted' | 'not_restorable' }

/**
 * `POST /storage/files/:id/restore` (§4, §10): `pending_delete → active` в один клик. Квоту
 * не проверяет: восстановление разрешено сверх лимита — это возврат оплаченного объёма (§12);
 * тенант переходит в превышение, блокируются загрузки, обучение идёт. Счётчик возвращает
 * байты сам — триггер видит переход в засчитываемое положение (§13 к. 3: «снова считается»).
 */
export async function restoreFile(ctx: Ctx, mediaId: string): Promise<RestoreResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.execute(sql`
      select id, lifecycle, deleted_at, deleted_by, delete_reason, purge_after, origin, bytes from media_assets where id = ${mediaId}::uuid for update
    `) as unknown as { id: string, lifecycle: string, deleted_at: Date | null, deleted_by: string | null, delete_reason: string | null, purge_after: Date | null, origin: string, bytes: number }[]
    if (!row) return { ok: false, code: 'not_found' } // чужой тенант — 404 (CLAUDE.md п. 15)
    if (row.lifecycle === 'purged') return { ok: false, code: 'already_purged' }
    if (row.lifecycle !== 'pending_delete') return { ok: false, code: 'not_deleted' }
    // Голос кандидата из корзины не возвращается (`docs/v2/30` §7.6, §7.7; PR-29): туда его кладут
    // отзыв согласия, перезапись и ответ текстом — «записи видалено», обещано кандидату. Восстановление
    // вернуло бы запись без срока, мимо `interview.media_purge`.
    if (row.origin === 'interview_answer') return { ok: false, code: 'not_restorable' }
    await tx.execute(sql`
      update media_assets set lifecycle = 'active', deleted_at = null, deleted_by = null, delete_reason = null,
             purge_after = null, updated_at = now()
       where id = ${mediaId}::uuid
    `)
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'storage.file.restore',
      entity: 'media_assets',
      entityId: mediaId,
      before: { lifecycle: row.lifecycle, deletedAt: row.deleted_at, deletedBy: row.deleted_by, deleteReason: row.delete_reason, purgeAfter: row.purge_after },
      after: { lifecycle: 'active', origin: row.origin, bytes: Number(row.bytes) },
    })
    return { ok: true, lifecycle: 'active' }
  })
}

// ── storage.purge ───────────────────────────────────────────────────────────────────────

export interface PurgeReport { purged: number, bytes: number }

/** Партия задачи `storage.purge` за один проход по тенанту. */
export const PURGE_BATCH = 1000

/**
 * Задача `storage.purge` (§11, 04:00 ежедневно): всё из корзины с истёкшим `purge_after`
 * переходит в терминальное `purged` (§4). Строка `media_assets` не удаляется никогда —
 * на неё ссылаются `audit_log` и `workshop_submissions.files`, и сдача показывает «Файл
 * видалено {дата}» (§13 к. 3).
 *
 * **Объект в S3 не удаляется** (docs/v2/44 §8): безвозвратное удаление файлов — вопрос
 * владельца продукта (HANDOFF §6). До его ответа задача помечает строки и освобождает квоту,
 * а список к физическому удалению накапливается сам — это строки `lifecycle = 'purged'`, их
 * `key` и есть перечень объектов, — и выполняется по подтверждению. Квота к этому моменту уже
 * свободна: счётчик уменьшился в момент мягкого удаления (§7.2 п. 3), `purged` лишь
 * закрывает дорогу назад.
 *
 * Одна запись `storage.file.purge` в `audit_log` на партию, а не на файл: журнал удалений
 * отвечает «сколько и когда», пофайловый состав — в самой записи (`mediaIds`).
 */
export async function purgeDue(tenantId: string, now: Date = new Date()): Promise<PurgeReport> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`
      update media_assets set lifecycle = 'purged', updated_at = now()
       where id in (
         select id from media_assets
          where lifecycle = 'pending_delete' and purge_after <= ${now.toISOString()}::timestamptz
            -- Голос кандидата корзина не «очищает» пометкой: его объект удаляет по-настоящему
            -- interview.media_purge (docs/v2/30 §7.7, сквозная проверка 18 docs/v2/42 §5) —
            -- пометка purged без удаления оставила бы запись в S3 навсегда
            and origin <> 'interview_answer'
          order by purge_after
          limit ${PURGE_BATCH}
          for update skip locked)
      returning id, bytes, origin
    `) as unknown as { id: string, bytes: number, origin: string }[]
    if (!rows.length) return { purged: 0, bytes: 0 }
    const bytes = rows.reduce((s, r) => s + Number(r.bytes), 0)
    await recordAudit(tx, {
      tenantId,
      actorId: null,
      action: 'storage.file.purge',
      entity: 'media_assets',
      entityId: rows.length === 1 ? rows[0]!.id : null,
      after: { files: rows.length, bytes, mediaIds: rows.map(r => r.id), objectDeleted: false },
    })
    return { purged: rows.length, bytes }
  })
}

// ── storage.counter_reconcile ───────────────────────────────────────────────────────────

/** Нормальная гонка счётчика (§7.4 п. 2): до 10 МБ выравнивается молча. */
export const DRIFT_SILENT_BYTES = 10 * 1024 * 1024
/** …или 0,5 % объёма — больше этого дрейф означает путь записи мимо триггера. */
export const DRIFT_SILENT_SHARE = 0.005

export interface ReconcileReport {
  day: string
  factBytes: number
  counterBytes: number
  driftBytes: number
  alerted: boolean
  /** Девять ключей разбивки — для `tenant_usage.storage_by_category` (В-10). */
  byStage: Record<string, number>
}

/**
 * `storage.counter_reconcile` (§7.4 п. 2, §11) — внутри `usage.collect`: полный пересчёт,
 * суточный срез в `storage_usage_daily`, выравнивание счётчика по факту, расчёт дрейфа.
 * Дрейф в пределах нормальной гонки выравнивается молча; больше — пишется
 * `storage.counter_drift` в `audit_log` и уходит алерт оператору платформы: это дефект кода.
 *
 * Строки счётчика тенанта блокируются на время пересчёта — транзакции, меняющие файлы, ждут
 * и применяют свой шаг поверх выровненного значения, а не теряются в нём.
 */
export async function reconcileStorage(tenantId: string, day?: string): Promise<ReconcileReport> {
  const report = await withTenant(tenantId, null, async (tx) => {
    const [d] = await tx.execute(sql`
      select coalesce(${day ?? null}::date, (now() at time zone coalesce((select timezone from tenants where id = ${tenantId}::uuid), 'UTC'))::date)::text as day
    `) as unknown as { day: string }[]
    const snapshotDay = d!.day
    const counters = await tx.execute(sql`
      select origin, stage_code, bytes::bigint as bytes from storage_usage_counters for update
    `) as unknown as { origin: string, stage_code: string | null, bytes: string | number }[]
    const fact = await tx.execute(sql`
      select origin, stage_code, sum(bytes)::bigint as bytes, count(*)::int as files
        from media_assets where lifecycle in ${COUNTED}
       group by origin, stage_code
    `) as unknown as { origin: string, stage_code: string | null, bytes: string | number, files: number }[]

    const keyOf = (o: string, s: string | null) => `${o}\u0000${s ?? ''}`
    const counterBy = new Map(counters.map(c => [keyOf(c.origin, c.stage_code), Number(c.bytes)]))
    const factKeys = new Set(fact.map(f => keyOf(f.origin, f.stage_code)))
    let factBytes = 0
    let counterBytes = 0
    const byStage: Record<string, number> = Object.fromEntries([...LIFECYCLE_STAGE_CODES, STORAGE_OTHER_KEY].map(k => [k, 0]))

    for (const f of fact) {
      const bytes = Number(f.bytes)
      const counter = counterBy.get(keyOf(f.origin, f.stage_code)) ?? 0
      factBytes += bytes
      counterBytes += counter
      const stageKey = f.stage_code ?? STORAGE_OTHER_KEY
      byStage[stageKey] = (byStage[stageKey] ?? 0) + bytes
      await tx.execute(sql`
        insert into storage_usage_daily (tenant_id, day, origin, stage_code, bytes, files_count, counter_bytes, drift_bytes, collected_at)
        values (${tenantId}::uuid, ${snapshotDay}::date, ${f.origin}, ${f.stage_code}, ${bytes}, ${f.files}, ${counter}, ${counter - bytes}, now())
        on conflict on constraint storage_usage_daily_uq do update
          set bytes = excluded.bytes, files_count = excluded.files_count, counter_bytes = excluded.counter_bytes,
              drift_bytes = excluded.drift_bytes, collected_at = excluded.collected_at
      `)
      // Выравнивание счётчика по пересчёту (§7.4 п. 2): биллинг берёт значение пересчёта
      await tx.execute(sql`
        insert into storage_usage_counters (tenant_id, origin, stage_code, bytes, files_count, updated_at)
        values (${tenantId}::uuid, ${f.origin}, ${f.stage_code}, ${bytes}, ${f.files}, now())
        on conflict on constraint storage_usage_counters_pk do update
          set bytes = excluded.bytes, files_count = excluded.files_count, updated_at = now()
      `)
    }
    // Ключи, которых в факте нет, а в счётчике остались байты, — тоже дрейф
    for (const c of counters) {
      if (factKeys.has(keyOf(c.origin, c.stage_code))) continue
      const counter = Number(c.bytes)
      if (!counter) continue
      counterBytes += counter
      await tx.execute(sql`
        insert into storage_usage_daily (tenant_id, day, origin, stage_code, bytes, files_count, counter_bytes, drift_bytes, collected_at)
        values (${tenantId}::uuid, ${snapshotDay}::date, ${c.origin}, ${c.stage_code}, 0, 0, ${counter}, ${counter}, now())
        on conflict on constraint storage_usage_daily_uq do update
          set bytes = 0, files_count = 0, counter_bytes = excluded.counter_bytes, drift_bytes = excluded.drift_bytes, collected_at = excluded.collected_at
      `)
      await tx.execute(sql`
        update storage_usage_counters set bytes = 0, files_count = 0, updated_at = now()
         where origin = ${c.origin} and stage_code is not distinct from ${c.stage_code}
      `)
    }

    const driftBytes = counterBytes - factBytes
    const alerted = Math.abs(driftBytes) > DRIFT_SILENT_BYTES
      || (factBytes > 0 && Math.abs(driftBytes) / factBytes > DRIFT_SILENT_SHARE && Math.abs(driftBytes) > 0)
    if (alerted) {
      await recordAudit(tx, {
        tenantId,
        actorId: null,
        action: 'storage.counter_drift',
        entity: 'storage_usage_counters',
        after: { day: snapshotDay, counterBytes, factBytes, driftBytes },
      })
    }
    return { day: snapshotDay, factBytes, counterBytes, driftBytes, alerted, byStage }
  })
  // Алерт оператору платформы (§7.4 п. 2, §8: «внутренний алерт, не уведомление тенанту») —
  // тем же каналом, что и предупреждения лимитов: строка `platform_audit`
  if (report.alerted) {
    await db.insert(platformAudit).values({
      adminId: null,
      adminEmail: 'system',
      action: 'tenant.storage_counter_drift',
      subjectTenantId: tenantId,
      entity: 'storage_usage_counters',
      entityId: null,
      after: { day: report.day, counterBytes: report.counterBytes, factBytes: report.factBytes, driftBytes: report.driftBytes },
    })
  }
  return report
}

// ── storage.classify_backfill ───────────────────────────────────────────────────────────

/**
 * `storage.classify_backfill` (§7.1, §11): происхождение файлов, загруженных до PR-12 с
 * умолчанием `other`, выводится обратным поиском по ссылкам (сдачи, чек-листы, ресурсы,
 * обложки, аватары). Сама логика — SQL-функция `storage_classify_backfill()` миграции
 * `0083_v2_storage_quota`: она вызвана один раз при миграции для всех тенантов, а здесь —
 * повторно для одного тенанта под его RLS. Счётчик переносит байты между строками сам
 * (триггер видит смену `origin`). Возвращает число переклассифицированных файлов.
 */
export async function classifyBackfill(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const [r] = await tx.execute(sql`select storage_classify_backfill() as n`) as unknown as { n: number }[]
    return Number(r?.n ?? 0)
  })
}

// ── Адресаты уведомлений хранилища ──────────────────────────────────────────────────────

/**
 * Кому уходят уведомления хранилища, адресованные «admin» (§8): люди, чья роль даёт
 * `storage.view`, — администратор и владелец. Не по коду роли, а по праву: кастомная роль с
 * этим скоупом тоже отвечает за место. Только сотрудники (правило 17) и только действующие.
 */
export async function storageAdmins(tx: TenantTx): Promise<string[]> {
  const rows = await tx.execute(sql`
    select distinct ur.user_id from user_roles ur
      join roles r on r.id = ur.role_id
      join users a on a.id = ur.user_id
     where r.scopes @> array['storage.view']::text[]
       and (ur.valid_until is null or ur.valid_until > now())
       and a.status = 'active' and not a.is_blocked ${EMPLOYEES_ONLY('a')}
  `) as unknown as { user_id: string }[]
  return rows.map(r => r.user_id)
}
