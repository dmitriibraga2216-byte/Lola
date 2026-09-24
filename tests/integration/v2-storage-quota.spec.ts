import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { LIFECYCLE_STAGE_CODES, MEDIA_ORIGINS } from '../../shared/enums'

/**
 * PR-36 пакета `docs/v2` (`45-plan.md`): квота, корзина, сроки хранения.
 *
 * Критерии приёмки `docs/v2/34-storage.md` §13, закреплённые за PR:
 *   к. 1 — исчерпанная квота: запись остаётся на устройстве, сдача «Очікує вивантаження»,
 *          срок засчитан временем записи, администратору `storage_upload_blocked`; докупили
 *          место — файл в S3, сдача у ментора, сотруднику `storage_pending_upload_done`;
 *   к. 3 — удалённый файл через 29 дней восстанавливается и снова в квоте; через 31 день —
 *          строка `purged`, сдача показывает «Файл видалено». Объект в S3 **остаётся**:
 *          purge не удаляет объект до ответа владельца продукта (`44` §8, условие входа PR-36);
 *   к. 4 — сертификат в массовом удалении пропускается с `not_deletable`; тенант с файлами всех
 *          происхождений — доля `other` на экране не больше 5 %;
 *   к. 7 — опция не оплачена и потребление выше базового лимита: наступил следующий период —
 *          ни один файл не удалён, загрузки заблокированы, обучение доступно.
 *
 * Условие выхода: сквозная проверка 23 (`42` §5) и одна формула эффективного лимита на
 * баннер и счёт — лимит хранилища на экране, в баннере и в проверке загрузки один и тот же
 * и берётся из `effectiveLimits()` (`tenantLimits.ts`), в сервисах хранилища формулы нет.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'
process.env.PLATFORM_DATABASE_URL ??= 'postgres://platform_admin:platform_admin_dev@localhost:5432/lola'

const { effectiveLimits, invalidateLimits, graceOf, GIB } = await import('../../server/services/tenantLimits')
const {
  storageSummary, storageUsedBytes, storageFactBytes, canStore, listStorageFiles, restoreFile, purgeDue,
  reconcileStorage, classifyBackfill, quotaTone, DRIFT_SILENT_BYTES,
} = await import('../../server/services/storage')
const { createDeletionRequest, confirmDeletionRequest, cancelDeletionRequest } = await import('../../server/services/storageDeletion')
const { listRetentionPolicies, saveRetentionPolicies, retentionDryRun } = await import('../../server/services/storagePolicies')
const { pendingUploadRetry, PENDING_UPLOAD_TTL_DAYS } = await import('../../server/services/storagePending')
const { createUploadUrl, completeUpload, softDeleteMedia, s3, S3_BUCKET, ensureBucket, CONFIRM_DELETE_PHRASE } = await import('../../server/services/media')
const { createWorkshop, submitWorkshop, saveDraft, reviewQueue, claim, grade, submissionForReview, workshopForLearner } = await import('../../server/services/workshops')
const { usageByAxis } = await import('../../server/services/usageCounters')
const { grantTenantAddon } = await import('../../server/services/platformTenants')
const { platformLogin, validatePlatformSession, ensureFirstAdmin } = await import('../../server/services/platform')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const OPS_EMAIL = 'ops-v2-36@lola.local'
const OPS_PASSWORD = 'test-password-136'
const stamp = Date.now()

let tenantId: string
let adminId: string
let employeeId: string
let mentorId: string
let adminCtx: { tenantId: string, actorId: string }
let employeeCtx: { tenantId: string, actorId: string }
let mentorCtx: { tenantId: string, actorId: string }
let opsAuth: Awaited<ReturnType<typeof validatePlatformSession>>

const createdMedia: string[] = []
const createdWorkshops: string[] = []
let otherTenantId: string | null = null

/** Файл в реестре напрямую — без S3: проверяются правила хранилища, а не транспорт. */
async function makeMedia(fields: { origin: string, bytes?: number, isEvidence?: boolean, tenant?: string, owner?: string | null, createdAt?: string, lifecycle?: string }): Promise<string> {
  const tenant = fields.tenant ?? tenantId
  const [row] = await admin`
    insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status, owner_user_id, origin, is_evidence, created_at)
    values (${tenant}, ${`t/${tenant}/v2-36-${stamp}-${createdMedia.length}.bin`}, ${`f-${createdMedia.length}.bin`}, 'file', 'application/pdf',
            ${fields.bytes ?? 1000}, 'ready', ${fields.owner === undefined ? adminId : fields.owner}, ${fields.origin}, ${fields.isEvidence ?? false},
            ${fields.createdAt ?? new Date().toISOString()})
    returning id`
  createdMedia.push(row!.id as string)
  return row!.id as string
}

async function setStorageOverride(gb: number | null) {
  await admin`insert into tenant_limits (tenant_id, storage_gb) values (${tenantId}, ${gb}) on conflict (tenant_id) do update set storage_gb = ${gb}`
  invalidateLimits(tenantId)
}

async function notificationsOf(userId: string, code: string): Promise<Record<string, unknown>[]> {
  return admin`select code, payload, dedup_key from notifications where tenant_id = ${tenantId} and user_id = ${userId} and code = ${code} order by created_at`
}

/**
 * «Сейчас» по часам базы, а не процесса: часы ВМ с Postgres могут уходить от часов хоста на
 * секунды, и отсечка `created_at >= since` по времени Node захватывала бы записи прошлого теста.
 */
async function dbNow(): Promise<Date> {
  const [r] = await admin`select now() as now`
  return r!.now as Date
}

async function auditOf(action: string, since: Date): Promise<Record<string, unknown>[]> {
  return admin`select action, entity, entity_id, after, request_context from audit_log where tenant_id = ${tenantId} and action = ${action} and created_at >= ${since} order by created_at`
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  const id = async (phone: string) => (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id as string
  adminId = await id('+380661864742')
  employeeId = await id('+380670000003')
  mentorId = await id('+380670000002')
  adminCtx = { tenantId, actorId: adminId }
  employeeCtx = { tenantId, actorId: employeeId }
  mentorCtx = { tenantId, actorId: mentorId }

  // Повторный прогон на той же базе не должен видеть хвостов прошлого: уведомления хранилища
  // дедуплицируются по суткам, строки ожидания и политики — по ключам
  await admin`delete from notifications where tenant_id = ${tenantId} and code like 'storage_%'`
  await admin`delete from storage_pending_uploads where tenant_id = ${tenantId}`
  await admin`delete from storage_deletion_requests where tenant_id = ${tenantId}`
  await admin`delete from storage_retention_policies where tenant_id = ${tenantId}`

  process.env.PLATFORM_ADMIN_EMAIL = OPS_EMAIL
  process.env.PLATFORM_ADMIN_PASSWORD = OPS_PASSWORD
  await admin`delete from platform_admins where email = ${OPS_EMAIL}`
  await ensureFirstAdmin()
  const session = await platformLogin(OPS_EMAIL, OPS_PASSWORD)
  opsAuth = await validatePlatformSession(session!.token)
}, 60_000)

afterAll(async () => {
  await admin`delete from tenant_addons where tenant_id = ${tenantId}`
  await admin`update tenant_limits set storage_gb = null where tenant_id = ${tenantId}`
  invalidateLimits(tenantId)
  await admin`delete from storage_pending_uploads where tenant_id = ${tenantId}`
  await admin`delete from storage_deletion_requests where tenant_id = ${tenantId}`
  await admin`delete from storage_usage_daily where tenant_id = ${tenantId}`
  // Политики — к умолчаниям посева: сервис досеет строки заново при первом обращении
  await admin`delete from storage_retention_policies where tenant_id = ${tenantId}`
  await admin`delete from notifications where tenant_id = ${tenantId} and code like 'storage_%'`
  if (createdWorkshops.length) {
    await admin`delete from review_queue_items where source_id in (select id from workshop_submissions where workshop_id in ${admin(createdWorkshops)})`
    await admin`delete from workshop_submissions where workshop_id in ${admin(createdWorkshops)}`
    await admin`delete from workshops where id in ${admin(createdWorkshops)}`
  }
  if (createdMedia.length) await admin`delete from media_assets where id in ${admin(createdMedia)}`
  if (otherTenantId) {
    await admin`delete from notices where tenant_id = ${otherTenantId}`
    await admin`delete from media_assets where tenant_id = ${otherTenantId}`
    await admin`delete from users where tenant_id = ${otherTenantId}`
    await admin`delete from tenants where id = ${otherTenantId}`
  }
  await admin`delete from platform_audit where admin_email = ${OPS_EMAIL} or (subject_tenant_id = ${tenantId} and action = 'tenant.storage_counter_drift')`
  await admin`delete from platform_sessions where admin_id in (select id from platform_admins where email = ${OPS_EMAIL})`
  await admin`delete from platform_admins where email = ${OPS_EMAIL}`
  await admin.end()
})

// ── Схема ─────────────────────────────────────────────────────────────────────────────

describe('миграция: пять таблиц хранилища и триггер счётчика (`34` §3.3, §7.4)', () => {
  it('таблицы есть, storage_quota_addons — нет (сквозная проверка 23, Р-6)', async () => {
    for (const t of ['storage_usage_counters', 'storage_usage_daily', 'storage_retention_policies', 'storage_deletion_requests', 'storage_pending_uploads']) {
      const [r] = await admin`select to_regclass(${`public.${t}`}) as reg`
      expect(r!.reg, t).not.toBeNull()
    }
    const [q] = await admin`select to_regclass('public.storage_quota_addons') as reg`
    expect(q!.reg).toBeNull()
  })

  it('ключ разбивки — код этапа (В-10): свободного значения счётчик не принимает', async () => {
    await expect(admin`insert into storage_usage_counters (tenant_id, origin, stage_code) values (${tenantId}, 'other', 'моя категорія')`).rejects.toThrow()
  })

  it('триггер: загрузка +bytes, мягкое удаление −bytes, перенос при смене происхождения', async () => {
    const before = await storageUsedBytes(tenantId)
    const id = await makeMedia({ origin: 'lesson_attachment', bytes: 7000 })
    expect(await storageUsedBytes(tenantId)).toBe(before + 7000)
    await admin`update media_assets set origin = 'content_cover' where id = ${id}`
    expect(await storageUsedBytes(tenantId)).toBe(before + 7000)
    const [cover] = await admin`select bytes from storage_usage_counters where tenant_id = ${tenantId} and origin = 'content_cover' and stage_code is null`
    expect(Number(cover!.bytes)).toBeGreaterThanOrEqual(7000)
    expect((await softDeleteMedia(adminCtx, id, { reason: 'дубль' })).ok).toBe(true)
    expect(await storageUsedBytes(tenantId)).toBe(before)
    // Счётчик = пересчёт по определению §7.4 п. 3: засчитываются active и orphaned
    expect(await storageUsedBytes(tenantId)).toBe(await storageFactBytes(tenantId))
  })
})

// ── Одна формула лимита ───────────────────────────────────────────────────────────────

describe('условие выхода: одна формула эффективного лимита на экран, баннер и счёт', () => {
  afterAll(async () => {
    await admin`delete from tenant_addons where tenant_id = ${tenantId}`
    await setStorageOverride(null)
  })

  it('сводка хранилища, баннер оси и проверка загрузки берут лимит из effectiveLimits()', async () => {
    await setStorageOverride(3)
    expect((await grantTenantAddon(tenantId, { addonCode: 'storage_pack', qty: 1 }, opsAuth!)).ok).toBe(true)
    const eff = await effectiveLimits(tenantId)
    expect(eff.axes.storage_bytes).toBe(103 * GIB) // 3 ГБ переопределения + 100 ГБ опции

    const summary = await storageSummary(adminCtx)
    expect(summary.limitBytes).toBe(eff.axes.storage_bytes)
    expect(summary.graceBytes).toBe(graceOf('storage_bytes', eff.axes.storage_bytes))
    expect(summary.graceBytes).toBe(GIB) // 2 % от 103 ГБ больше 1 ГБ — берётся меньшее

    // Баннер (PR-09) читает тот же счётчик и тот же лимит
    const banner = (await usageByAxis(tenantId)).find(a => a.axis === 'storage_bytes')!
    expect(banner.limit).toBe(summary.limitBytes)
    expect(banner.used).toBe(summary.usedBytes)

    const check = await canStore(tenantId, 1)
    expect(check.limit).toBe(summary.limitBytes)
    expect(check.grace).toBe(summary.graceBytes)
  })

  it('допуск для начатых загрузок: 2 % лимита или 1 ГБ, что меньше (§7.5)', () => {
    expect(graceOf('storage_bytes', 10 * GIB)).toBe(Math.floor(10 * GIB * 0.02))
    expect(graceOf('storage_bytes', 500 * GIB)).toBe(GIB)
    expect(graceOf('storage_bytes', null)).toBe(0)
    expect(graceOf('users_active', 100)).toBe(0) // у остальных осей допуска нет
  })

  it('полоса: бирюза до 80 %, солнце 80–95 %, коралл выше 95 % (§5.1)', () => {
    expect(quotaTone(null)).toBe('teal')
    expect(quotaTone(79.9)).toBe('teal')
    expect(quotaTone(80)).toBe('sun')
    expect(quotaTone(95)).toBe('sun')
    expect(quotaTone(95.1)).toBe('coral')
  })
})

// ── Критерий 1: отложенная загрузка ───────────────────────────────────────────────────

describe('`34` §13 к. 1: квота исчерпана — запись ждёт на устройстве и досылается', () => {
  let workshopId: string
  let submissionId: string
  let pendingId: string
  const clientRef = `dev:v2-36-${stamp}`
  const upload = { filename: 'answer.webm', mime: 'video/webm', bytes: 4096, origin: 'workshop_submission' as const, sourceEntity: 'workshops' }

  beforeAll(async () => {
    const w = await createWorkshop(adminCtx, { title: `Відео-відповідь ${stamp}`, description: [], submissionKinds: ['video'], criteria: [{ text: 'Показав виконання' }], status: 'published' })
    workshopId = w.id
    createdWorkshops.push(w.id)
    await setStorageOverride(1)
    await makeMedia({ origin: 'import', bytes: 1_200_000_000 }) // 1,2 ГБ при лимите 1 ГБ + допуск 21 МБ
  })

  afterAll(async () => {
    await admin`delete from tenant_addons where tenant_id = ${tenantId}`
    await setStorageOverride(null)
  })

  it('загрузка без места и без ключа устройства — отказ, как прежде', async () => {
    const r = await createUploadUrl(employeeCtx, { ...upload, sourceId: workshopId })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('storage_limit')
  })

  it('с ключом устройства — не отказ, а отложенная загрузка на 14 дней', async () => {
    const r = await createUploadUrl(employeeCtx, { ...upload, sourceId: workshopId, clientRef })
    expect(r.ok).toBe(false)
    if (r.ok || r.code !== 'deferred') throw new Error('ожидалась отложенная загрузка')
    pendingId = r.pendingId
    const [row] = await admin`select status, declared_bytes, origin, expires_at, created_at from storage_pending_uploads where id = ${pendingId}`
    expect(row!.status).toBe('waiting')
    expect(Number(row!.declared_bytes)).toBe(4096)
    const ttl = (new Date(row!.expires_at as string).getTime() - new Date(row!.created_at as string).getTime()) / 86_400_000
    expect(Math.round(ttl)).toBe(PENDING_UPLOAD_TTL_DAYS)

    // Повтор с того же устройства не плодит строк и уведомлений
    const again = await createUploadUrl(employeeCtx, { ...upload, sourceId: workshopId, clientRef })
    expect(!again.ok && again.code === 'deferred' && again.pendingId).toBe(pendingId)

    expect(await notificationsOf(employeeId, 'storage_upload_deferred')).toHaveLength(1)
    const blocked = await notificationsOf(adminId, 'storage_upload_blocked')
    expect(blocked.length).toBeGreaterThanOrEqual(1)
    expect((blocked[0]!.payload as { n: number }).n).toBeGreaterThanOrEqual(1)
  })

  it('сдача уходит с файлом-обещанием: срок засчитан временем записи, ментор её видит, но взять не может', async () => {
    const recordedAt = new Date()
    const r = await submitWorkshop(employeeCtx, workshopId, { files: [{ pendingId, name: 'answer.webm', kind: 'video', bytes: 4096 }] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    submissionId = r.submissionId
    expect(r.pendingUpload).toBe(true)

    const [s] = await admin`select status, submitted_at from workshop_submissions where id = ${submissionId}`
    expect(s!.status).toBe('submitted')
    // Дедлайн — по времени записи, а не успешной загрузки (§7.5 п. 2)
    expect(Math.abs(new Date(s!.submitted_at as string).getTime() - recordedAt.getTime())).toBeLessThan(60_000)

    const item = (await reviewQueue(mentorCtx)).find(i => i.id === submissionId)
    expect(item?.pendingUpload).toBe(true)
    expect(await claim(mentorCtx, submissionId)).toEqual({ ok: false, code: 'pending_upload' })
    // Проверяющих не зовут, пока проверять нечего
    const [called] = await admin`select count(*)::int as n from notifications where tenant_id = ${tenantId} and code = 'workshop_submitted' and dedup_key like ${`ws_submitted:${submissionId}:%`}`
    expect(called!.n).toBe(0)

    const learner = await workshopForLearner(employeeCtx, workshopId)
    expect(learner?.current?.pendingUpload).toBe(true)
  })

  it('администратор докупил место — место выдаётся ждущей записи сразу (§7.5 п. 4)', async () => {
    expect((await grantTenantAddon(tenantId, { addonCode: 'storage_pack', qty: 1 }, opsAuth!)).ok).toBe(true)
    const [row] = await admin`select status, attempts from storage_pending_uploads where id = ${pendingId}`
    expect(row!.status).toBe('uploading')
    expect(row!.attempts).toBe(1)
  })

  it('устройство досылает: файл в S3, сдача у ментора, сотруднику storage_pending_upload_done', async () => {
    await ensureBucket()
    const r = await createUploadUrl(employeeCtx, { ...upload, sourceId: workshopId, clientRef })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    createdMedia.push(r.mediaId)
    expect(r.pendingId).toBe(pendingId)
    const put = await fetch(r.uploadUrl, { method: 'PUT', body: new Uint8Array(4096), headers: { 'Content-Type': 'video/webm' } })
    expect(put.ok).toBe(true)
    const done = await completeUpload(employeeCtx, r.mediaId, { ownOnly: true })
    expect(done?.id).toBe(r.mediaId)

    await expect(s3().send(new HeadObjectCommand({ Bucket: S3_BUCKET(), Key: r.key }))).resolves.toBeDefined()
    const [p] = await admin`select status, media_id from storage_pending_uploads where id = ${pendingId}`
    expect(p!.status).toBe('done')
    expect(p!.media_id).toBe(r.mediaId)

    const [s] = await admin`select files from workshop_submissions where id = ${submissionId}`
    expect(s!.files).toEqual([{ mediaId: r.mediaId, name: 'answer.webm', kind: 'video', bytes: 4096 }])
    expect((await reviewQueue(mentorCtx)).find(i => i.id === submissionId)?.pendingUpload).toBe(false)
    expect(await notificationsOf(employeeId, 'storage_pending_upload_done')).toHaveLength(1)
    const [called] = await admin`select count(*)::int as n from notifications where tenant_id = ${tenantId} and code = 'workshop_submitted' and dedup_key like ${`ws_submitted:${submissionId}:%`}`
    expect(called!.n).toBeGreaterThan(0)
    expect(await claim(mentorCtx, submissionId)).toEqual({ ok: true })

    // Повтор с устройства после досылки — «уже отправлено», локальная копия больше не нужна
    const late = await createUploadUrl(employeeCtx, { ...upload, sourceId: workshopId, clientRef })
    expect(!late.ok && late.code).toBe('pending_done')
  })

  it('срок ожидания истёк — abandoned, файл в сдаче «втрачено», уведомление обоим', async () => {
    const lostRef = `dev:v2-36-lost-${stamp}`
    await admin`delete from tenant_addons where tenant_id = ${tenantId}`
    invalidateLimits(tenantId)
    const r = await createUploadUrl(employeeCtx, { ...upload, sourceId: workshopId, clientRef: lostRef })
    if (r.ok || r.code !== 'deferred') throw new Error('ожидалась отложенная загрузка')
    const w2 = await createWorkshop(adminCtx, { title: `Відео 2 ${stamp}`, description: [], submissionKinds: ['video'], criteria: [{ text: 'Критерій' }], status: 'published' })
    createdWorkshops.push(w2.id)
    await saveDraft(employeeCtx, w2.id, { files: [{ pendingId: r.pendingId, name: 'lost.webm', kind: 'video', bytes: 4096 }] })
    await admin`update storage_pending_uploads set expires_at = now() - interval '1 minute' where id = ${r.pendingId}`

    const report = await pendingUploadRetry(tenantId)
    expect(report.abandoned).toBeGreaterThanOrEqual(1)
    const [p] = await admin`select status from storage_pending_uploads where id = ${r.pendingId}`
    expect(p!.status).toBe('abandoned')
    const [s] = await admin`select files from workshop_submissions where workshop_id = ${w2.id}`
    expect((s!.files as { lost?: boolean }[])[0]!.lost).toBe(true)
    expect(await notificationsOf(employeeId, 'storage_pending_upload_expired')).toHaveLength(1)
    expect((await notificationsOf(adminId, 'storage_pending_upload_expired')).length).toBeGreaterThanOrEqual(1)
  })

  it('очередь FIFO: ранняя большая запись не пропускается вперёд поздней маленькой', async () => {
    const big = `dev:v2-36-big-${stamp}`
    const small = `dev:v2-36-small-${stamp}`
    const rb = await createUploadUrl(employeeCtx, { ...upload, bytes: 400_000_000, mime: 'video/mp4', sourceId: workshopId, clientRef: big })
    const rs = await createUploadUrl(employeeCtx, { ...upload, sourceId: workshopId, clientRef: small })
    if (rb.ok || rs.ok) throw new Error('ожидались отложенные загрузки')
    const retry = await pendingUploadRetry(tenantId)
    expect(retry.granted).toBe(0)
    const rows = await admin`select client_ref, status from storage_pending_uploads where client_ref in (${big}, ${small})`
    expect(rows.every(r => r.status === 'waiting')).toBe(true)
  })
})

// ── Критерий 3: корзина и purge ───────────────────────────────────────────────────────

describe('`34` §13 к. 3: 29 дней — восстановление, 31 день — purged, «Файл видалено»', () => {
  let workshopId: string
  let submissionId: string
  let mediaId: string
  let key: string

  beforeAll(async () => {
    await ensureBucket()
    const w = await createWorkshop(adminCtx, { title: `Фото-звіт ${stamp}`, description: [], submissionKinds: ['photo'], criteria: [{ text: 'Чисто' }], status: 'published' })
    workshopId = w.id
    createdWorkshops.push(w.id)
    const r = await createUploadUrl(employeeCtx, { filename: 'shot.png', mime: 'image/png', bytes: 2048, origin: 'workshop_submission', sourceEntity: 'workshops', sourceId: workshopId })
    if (!r.ok) throw new Error(`загрузка не выдана: ${r.code}`)
    mediaId = r.mediaId
    key = r.key
    createdMedia.push(mediaId)
    await s3().send(new PutObjectCommand({ Bucket: S3_BUCKET(), Key: key, Body: new Uint8Array(2048), ContentType: 'image/png' }))
    await completeUpload(employeeCtx, mediaId, { ownOnly: true })
    const s = await submitWorkshop(employeeCtx, workshopId, { files: [{ mediaId, name: 'shot.png', kind: 'photo', bytes: 2048 }] })
    if (!s.ok) throw new Error('сдача не прошла')
    submissionId = s.submissionId
    expect((await claim(mentorCtx, submissionId)).ok).toBe(true)
    const g = await grade(mentorCtx, submissionId, { decision: 'accepted', criteriaResults: [{ criterionId: 'c1', passed: true }] })
    expect(g.ok).toBe(true)
  })

  it('решение по сдаче делает файл доказательством (§7.1 п. 2)', async () => {
    const [m] = await admin`select is_evidence from media_assets where id = ${mediaId}`
    expect(m!.is_evidence).toBe(true)
  })

  it('через 29 дней файл восстанавливается и снова считается в квоте', async () => {
    const before = await storageUsedBytes(tenantId)
    const del = await softDeleteMedia(adminCtx, mediaId, { reason: 'помилковий знімок', confirmPhrase: CONFIRM_DELETE_PHRASE })
    expect(del.ok).toBe(true)
    expect(await storageUsedBytes(tenantId)).toBe(before - 2048)
    await admin`update media_assets set deleted_at = now() - interval '29 days', purge_after = now() + interval '1 day' where id = ${mediaId}`
    expect(await purgeDue(tenantId)).toMatchObject({ purged: 0 })

    const since = await dbNow()
    expect(await restoreFile(adminCtx, mediaId)).toEqual({ ok: true, lifecycle: 'active' })
    expect(await storageUsedBytes(tenantId)).toBe(before)
    const [m] = await admin`select lifecycle, deleted_at, purge_after from media_assets where id = ${mediaId}`
    expect(m).toMatchObject({ lifecycle: 'active', deleted_at: null, purge_after: null })
    expect(await auditOf('storage.file.restore', since)).toHaveLength(1)
  })

  it('через 31 день — purged: восстановить нельзя, квота свободна, объект в S3 ждёт решения владельца', async () => {
    const del = await softDeleteMedia(adminCtx, mediaId, { reason: 'помилковий знімок', confirmPhrase: CONFIRM_DELETE_PHRASE })
    expect(del.ok).toBe(true)
    await admin`update media_assets set deleted_at = now() - interval '31 days', purge_after = now() - interval '1 day' where id = ${mediaId}`
    const used = await storageUsedBytes(tenantId)
    const since = await dbNow()
    const report = await purgeDue(tenantId)
    expect(report.purged).toBeGreaterThanOrEqual(1)

    const [m] = await admin`select lifecycle, key from media_assets where id = ${mediaId}`
    expect(m!.lifecycle).toBe('purged')
    expect(await restoreFile(adminCtx, mediaId)).toEqual({ ok: false, code: 'already_purged' })
    expect(await storageUsedBytes(tenantId)).toBe(used) // квоту освободило удаление, purge её не трогает
    const audit = await auditOf('storage.file.purge', since)
    expect(audit).toHaveLength(1)
    expect((audit[0]!.after as { mediaIds: string[], objectDeleted: boolean }).mediaIds).toContain(mediaId)
    expect((audit[0]!.after as { objectDeleted: boolean }).objectDeleted).toBe(false)

    // `44` §8: объект не удаляется до ответа владельца; строка purged и есть список к удалению
    await expect(s3().send(new HeadObjectCommand({ Bucket: S3_BUCKET(), Key: key }))).resolves.toBeDefined()
    const list = await admin`select key from media_assets where tenant_id = ${tenantId} and lifecycle = 'purged'`
    expect(list.map(r => r.key)).toContain(key)
  })

  it('сдача остаётся, оценка на месте, файл показан как удалённый («Файл видалено {дата}»)', async () => {
    const card = await submissionForReview(adminCtx, submissionId)
    expect(card?.submission.status).toBe('accepted')
    const file = (card!.submission.files as { mediaId: string, lifecycle?: string, deletedAt?: string | null }[])[0]!
    expect(file.mediaId).toBe(mediaId)
    expect(file.lifecycle).toBe('purged')
    expect(file.deletedAt).toBeTruthy()
    const learner = await workshopForLearner(employeeCtx, workshopId)
    expect((learner!.current!.files as { deletedAt?: string | null }[])[0]!.deletedAt).toBeTruthy()
  })

  it('срок корзины живёт строкой политики, а не константой (`44` §8)', async () => {
    await admin`update storage_retention_policies set trash_days = 7 where tenant_id = ${tenantId} and origin = 'import'`
    const id = await makeMedia({ origin: 'import', bytes: 10 })
    const r = await softDeleteMedia(adminCtx, id, { reason: 'застарілий імпорт' })
    expect(r.ok).toBe(true)
    const [m] = await admin`select deleted_at, purge_after from media_assets where id = ${id}`
    const days = (new Date(m!.purge_after as string).getTime() - new Date(m!.deleted_at as string).getTime()) / 86_400_000
    expect(Math.round(days)).toBe(7)
    await admin`update storage_retention_policies set trash_days = 30 where tenant_id = ${tenantId} and origin = 'import'`
  })
})

// ── Критерий 4: массовое удаление и доля «Інше» ───────────────────────────────────────

describe('`34` §13 к. 4: массовое удаление заявкой, сертификат пропускается', () => {
  it('черновик считает файлы, доказательства и заведомо пропускаемое', async () => {
    const cert = await makeMedia({ origin: 'certificate', bytes: 100 })
    const plain = await makeMedia({ origin: 'report_export', bytes: 300 })
    const evidence = await makeMedia({ origin: 'video_answer', bytes: 500, isEvidence: true })
    const r = await createDeletionRequest(adminCtx, { mode: 'selection', mediaIds: [cert, plain, evidence] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.request).toMatchObject({ status: 'draft', plannedFiles: 2, plannedBytes: 800, evidenceCount: 1, notDeletableCount: 1 })

    // Без причины и слова «ВИДАЛИТИ» — ни один файл не удаляется (§6.1)
    expect(await confirmDeletionRequest(adminCtx, r.request.id, { acknowledged: true })).toEqual({ ok: false, code: 'reason_required' })
    expect(await confirmDeletionRequest(adminCtx, r.request.id, { acknowledged: true, reason: 'дублікати записів', confirmPhrase: 'видалити' })).toEqual({ ok: false, code: 'confirm_phrase_mismatch' })
    const still = await admin`select lifecycle from media_assets where id in (${plain}, ${evidence})`
    expect(still.every(m => m.lifecycle === 'active')).toBe(true)

    const since = await dbNow()
    const done = await confirmDeletionRequest(adminCtx, r.request.id, { acknowledged: true, reason: 'дублікати записів', confirmPhrase: CONFIRM_DELETE_PHRASE })
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.request).toMatchObject({ status: 'done', deletedFiles: 2, deletedBytes: 800 })
    expect(done.request.skipped).toEqual([{ mediaId: cert, reason: 'not_deletable' }])

    const rows = await admin`select id, lifecycle, delete_reason from media_assets where id in (${cert}, ${plain}, ${evidence})`
    const byId = Object.fromEntries(rows.map(m => [m.id as string, m]))
    expect(byId[cert]!.lifecycle).toBe('active')
    expect(byId[plain]!.lifecycle).toBe('pending_delete')
    expect(byId[evidence]!.delete_reason).toBe('дублікати записів')

    // Одна запись на заявку, пофайловый состав — в самой заявке (§7.2 п. 4)
    const audit = await auditOf('storage.bulk_delete', since)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.entity).toBe('storage_deletion_requests')
    expect(await notificationsOf(adminId, 'storage_bulk_delete_done')).not.toHaveLength(0)

    // Повторное подтверждение — уже исполнено, второй раз не удаляет
    expect(await confirmDeletionRequest(adminCtx, r.request.id, { acknowledged: true })).toEqual({ ok: false, code: 'not_draft' })
  })

  it('второй администратор по той же выборке получает already_deleted, счётчик уменьшается один раз (§12)', async () => {
    const a = await makeMedia({ origin: 'report_export', bytes: 1234 })
    const first = await createDeletionRequest(adminCtx, { mode: 'selection', mediaIds: [a] })
    const second = await createDeletionRequest(adminCtx, { mode: 'selection', mediaIds: [a] })
    if (!first.ok || !second.ok) throw new Error('черновики не созданы')
    const before = await storageUsedBytes(tenantId)
    expect((await confirmDeletionRequest(adminCtx, first.request.id, { acknowledged: true })).ok).toBe(true)
    const again = await confirmDeletionRequest(adminCtx, second.request.id, { acknowledged: true })
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.request.skipped).toEqual([{ mediaId: a, reason: 'already_deleted' }])
    expect(await storageUsedBytes(tenantId)).toBe(before - 1234)
  })

  it('файл сдачи на проверке пропускается с under_review, отмена возможна только до подтверждения', async () => {
    const w = await createWorkshop(adminCtx, { title: `На перевірці ${stamp}`, description: [], submissionKinds: ['file'], criteria: [{ text: 'Є файл' }], status: 'published' })
    createdWorkshops.push(w.id)
    const m = await makeMedia({ origin: 'workshop_submission', bytes: 50, owner: employeeId })
    const s = await submitWorkshop(employeeCtx, w.id, { files: [{ mediaId: m, name: 'f.pdf', kind: 'file', bytes: 50 }] })
    expect(s.ok).toBe(true)
    const r = await createDeletionRequest(adminCtx, { mode: 'selection', mediaIds: [m] })
    if (!r.ok) throw new Error('черновик не создан')
    expect(r.request).toMatchObject({ plannedFiles: 0, notDeletableCount: 1 })
    expect(await cancelDeletionRequest(adminCtx, r.request.id)).toEqual({ ok: true })
    expect(await cancelDeletionRequest(adminCtx, r.request.id)).toEqual({ ok: false, code: 'not_draft' })
    // Одиночное удаление того же файла — 409 under_review (§12)
    const single = await softDeleteMedia(adminCtx, m, {})
    expect(!single.ok && single.code).toBe('under_review')
  })
})

describe('`34` §13 к. 4: тенант с файлами всех происхождений — «Інше» не больше 5 % объёма', () => {
  let ownerId: string

  beforeAll(async () => {
    const [t] = await admin`insert into tenants (slug, name, status) values (${`v2-36-origins-${stamp}`}, 'Сховище: всі походження', 'active') returning id`
    otherTenantId = t!.id as string
    const [u] = await admin`insert into users (tenant_id, full_name, status, kind) values (${otherTenantId}, 'Адмін сховища', 'active', 'employee') returning id`
    ownerId = u!.id as string
    for (const origin of MEDIA_ORIGINS) {
      await makeMedia({ origin, bytes: origin === 'other' ? 40_000 : 1_000_000, tenant: otherTenantId, owner: ownerId })
    }
  })

  it('разбивка «За походженням» показывает все шестнадцать значений, доля other ≤ 5 %', async () => {
    const s = await storageSummary({ tenantId: otherTenantId!, actorId: ownerId }, 'origin')
    expect(s.breakdown.map(b => b.key).sort()).toEqual([...MEDIA_ORIGINS].sort())
    expect(s.otherShare).toBeGreaterThan(0)
    expect(s.otherShare).toBeLessThanOrEqual(0.05)
    expect(s.otherFiles).toBe(1)
    // Бары по убыванию (§5.1)
    const bytes = s.breakdown.map(b => b.bytes)
    expect([...bytes].sort((a, b) => b - a)).toEqual(bytes)
  })

  it('«За етапом» — ровно девять ключей: восемь кодов этапов и other (В-10)', async () => {
    const s = await storageSummary({ tenantId: otherTenantId!, actorId: ownerId }, 'stage')
    expect(s.breakdown.map(b => b.key).sort()).toEqual([...LIFECYCLE_STAGE_CODES, 'other'].sort())
    expect(s.breakdown.find(b => b.key === 'other')!.bytes).toBe(s.usedBytes) // все файлы вне курса
  })

  it('storage.classify_backfill: файл «Інше», на который ссылается контент, получает происхождение', async () => {
    const legacy = await makeMedia({ origin: 'other', bytes: 900_000, tenant: otherTenantId!, owner: ownerId })
    // Вложение объявления ссылается на файл по id (`notices.attachments[].mediaId`)
    await admin`insert into notices (tenant_id, title, attachments) values (${otherTenantId}, ${`Оголошення ${stamp}`}, ${admin.json([{ mediaId: legacy, name: 'наказ.pdf' }])})`
    const before = await storageSummary({ tenantId: otherTenantId!, actorId: ownerId })
    expect(await classifyBackfill(otherTenantId!)).toBeGreaterThanOrEqual(1)
    const [m] = await admin`select origin from media_assets where id = ${legacy}`
    expect(m!.origin).toBe('lesson_attachment')
    const after = await storageSummary({ tenantId: otherTenantId!, actorId: ownerId })
    expect(after.otherShare).toBeLessThan(before.otherShare)
    expect(after.usedBytes).toBe(before.usedBytes) // счётчик перенёс байты между строками, не потерял
  })

  it('чужой тенант — 404 и пустые выборки, не 403 (CLAUDE.md п. 15)', async () => {
    const foreign = createdMedia[createdMedia.length - 1]!
    expect(await restoreFile(adminCtx, foreign)).toEqual({ ok: false, code: 'not_found' })
    const mine = await listStorageFiles(adminCtx, { status: 'active', evidenceOnly: false, limit: 100 })
    expect(mine.items.some(i => i.id === foreign)).toBe(false)
    expect(await createDeletionRequest(adminCtx, { mode: 'selection', mediaIds: [foreign] })).toEqual({ ok: false, code: 'empty' })
  })
})

// ── Критерий 7: опция не оплачена ─────────────────────────────────────────────────────

describe('`34` §13 к. 7: опция не оплачена, потребление выше базового лимита', () => {
  let filler: string

  beforeAll(async () => {
    await setStorageOverride(1)
    filler = await makeMedia({ origin: 'import', bytes: 1_150_000_000 })
    // Опция «+100 ГБ» закончилась вчера: наступил следующий период, а оплаты не было
    await admin`insert into tenant_addons (tenant_id, addon_code, qty, unit_step, valid_from, valid_until)
                values (${tenantId}, 'storage_pack', 1, ${100 * GIB}, current_date - 31, current_date - 1)`
    invalidateLimits(tenantId)
  })

  afterAll(async () => {
    await admin`delete from tenant_addons where tenant_id = ${tenantId}`
    await setStorageOverride(null)
  })

  it('лимит вернулся к базовому, загрузки заблокированы — одной формулой', async () => {
    const eff = await effectiveLimits(tenantId)
    expect(eff.axes.storage_bytes).toBe(GIB)
    const s = await storageSummary(adminCtx)
    expect(s.blocked).toBe(true)
    expect(s.tone).toBe('coral')
    const r = await createUploadUrl(adminCtx, { filename: 'new.pdf', mime: 'application/pdf', bytes: 10, origin: 'lesson_attachment' })
    expect(!r.ok && r.code).toBe('storage_limit')
  })

  it('ни один файл не удалён — ни сразу, ни задачей purge (автоудаления за неуплату нет)', async () => {
    const before = await admin`select count(*)::int as n from media_assets where tenant_id = ${tenantId} and lifecycle = 'active'`
    await purgeDue(tenantId)
    await pendingUploadRetry(tenantId)
    const after = await admin`select count(*)::int as n from media_assets where tenant_id = ${tenantId} and lifecycle = 'active'`
    expect(after[0]!.n).toBe(before[0]!.n)
    const [f] = await admin`select lifecycle from media_assets where id = ${filler}`
    expect(f!.lifecycle).toBe('active')
  })

  it('обучение доступно полностью: работу можно сдать, запись не теряется', async () => {
    const w = await createWorkshop(adminCtx, { title: `Текст ${stamp}`, description: [], submissionKinds: ['text'], criteria: [{ text: 'Відповідь' }], status: 'published' })
    createdWorkshops.push(w.id)
    const s = await submitWorkshop(employeeCtx, w.id, { text: 'Відповідь без файлу — навчання не зупиняється' })
    expect(s.ok).toBe(true)
    const deferred = await createUploadUrl(employeeCtx, { filename: 'a.webm', mime: 'video/webm', bytes: 10, origin: 'workshop_submission', clientRef: `dev:v2-36-k7-${stamp}` })
    expect(!deferred.ok && deferred.code).toBe('deferred')
  })
})

// ── Суточный срез и дрейф ─────────────────────────────────────────────────────────────

describe('storage.counter_reconcile: суточный срез по девяти ключам и дрейф (§7.4 п. 2)', () => {
  it('дрейф 50 МБ: счётчик выровнен по пересчёту, storage.counter_drift в audit_log', async () => {
    await makeMedia({ origin: 'lesson_attachment', bytes: 5000 })
    await admin`update storage_usage_counters set bytes = bytes + ${50 * 1024 * 1024} where tenant_id = ${tenantId} and origin = 'lesson_attachment' and stage_code is null`
    expect(await storageUsedBytes(tenantId)).toBe(await storageFactBytes(tenantId) + 50 * 1024 * 1024)
    expect(50 * 1024 * 1024).toBeGreaterThan(DRIFT_SILENT_BYTES)

    const since = await dbNow()
    const report = await reconcileStorage(tenantId)
    expect(report.driftBytes).toBe(50 * 1024 * 1024)
    expect(report.alerted).toBe(true)
    expect(await storageUsedBytes(tenantId)).toBe(await storageFactBytes(tenantId))
    const audit = await auditOf('storage.counter_drift', since)
    expect(audit).toHaveLength(1)
    expect((audit[0]!.after as { driftBytes: number }).driftBytes).toBe(50 * 1024 * 1024)
    const [alert] = await admin`select count(*)::int as n from platform_audit where subject_tenant_id = ${tenantId} and action = 'tenant.storage_counter_drift' and created_at >= ${since}`
    expect(alert!.n).toBe(1)

    const daily = await admin`select origin, drift_bytes from storage_usage_daily where tenant_id = ${tenantId} and day = ${report.day}::date`
    expect(daily.find(d => d.origin === 'lesson_attachment')!.drift_bytes).toBe(String(50 * 1024 * 1024))
    expect(Object.keys(report.byStage).sort()).toEqual([...LIFECYCLE_STAGE_CODES, 'other'].sort())
  })

  it('нормальная гонка (≤ 10 МБ) выравнивается молча', async () => {
    await admin`update storage_usage_counters set bytes = bytes + 1024 where tenant_id = ${tenantId} and origin = 'lesson_attachment' and stage_code is null`
    const since = await dbNow()
    const report = await reconcileStorage(tenantId)
    expect(report.driftBytes).toBe(1024)
    expect(report.alerted).toBe(false)
    expect(await auditOf('storage.counter_drift', since)).toHaveLength(0)
  })
})

// ── Реестр и политики ─────────────────────────────────────────────────────────────────

describe('реестр файлов: курсор не теряет файлы одного мгновения', () => {
  it('три файла с одинаковым created_at — две страницы, без дублей и потерь', async () => {
    const at = '2021-01-01T00:00:00.123456Z'
    const ids = [await makeMedia({ origin: 'avatar', createdAt: at }), await makeMedia({ origin: 'avatar', createdAt: at }), await makeMedia({ origin: 'avatar', createdAt: at })]
    const query = { status: 'active' as const, evidenceOnly: false, to: '2021-01-01', from: '2021-01-01' }
    const p1 = await listStorageFiles(adminCtx, { ...query, limit: 2 })
    expect(p1.items).toHaveLength(2)
    expect(p1.nextCursor).toBeTruthy()
    const p2 = await listStorageFiles(adminCtx, { ...query, limit: 2, cursor: p1.nextCursor! })
    const seen = [...p1.items, ...p2.items].map(i => i.id)
    expect(new Set(seen).size).toBe(3)
    expect(seen.sort()).toEqual([...ids].sort())
  })
})

describe('политики хранения (§6.2, §7.3)', () => {
  it('строка на каждое происхождение, всё выключено, корзина 30 дней', async () => {
    const list = await listRetentionPolicies(adminCtx)
    expect(list.map(p => p.origin)).toEqual([...MEDIA_ORIGINS])
    expect(list.every(p => !p.enabled && p.trashDays === 30)).toBe(true)
  })

  it('первое включение — только после сухого прогона; доказательства — только с отметкой', async () => {
    const list = await listRetentionPolicies(adminCtx)
    const video = { ...list.find(p => p.origin === 'video_answer')!, enabled: true, keepMonths: 12, anchor: 'created_at' as const }
    expect(await saveRetentionPolicies(adminCtx, { policies: [video] })).toMatchObject({ ok: false, code: 'dry_run_required' })
    expect(await saveRetentionPolicies(adminCtx, { policies: [{ ...video, keepEvidence: false }], dryRunConfirmed: true })).toMatchObject({ ok: false, code: 'evidence_ack_required' })

    const old = await makeMedia({ origin: 'video_answer', bytes: 777, createdAt: '2023-01-01T00:00:00Z' })
    const dry = await retentionDryRun(adminCtx, { origin: 'video_answer', keepMonths: 12, anchor: 'created_at', action: 'soft_delete', keepEvidence: true })
    expect(dry.files).toBeGreaterThanOrEqual(1)
    expect(dry.bytes).toBeGreaterThanOrEqual(777)

    const since = await dbNow()
    const saved = await saveRetentionPolicies(adminCtx, { policies: [video], dryRunConfirmed: true })
    expect(saved.ok).toBe(true)
    expect(await auditOf('storage.policy.update', since)).toHaveLength(1)
    // Сухой прогон ничего не удаляет, сохранение политики — тоже (исполнение — отдельная задача)
    const [m] = await admin`select lifecycle from media_assets where id = ${old}`
    expect(m!.lifecycle).toBe('active')
  })
})

// ── HTTP: учащийся загружает свою работу, чужое — нет ─────────────────────────────────

const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3836
const BASE = `http://127.0.0.1:${PORT}`
const EMPLOYEE_PHONE = '+380670000003'

describe.skipIf(!BUILT)('HTTP: POST /media/upload-url для сотрудника (§7.5, `41` §5.7)', () => {
  let server: ChildProcess | undefined
  let cookie = ''

  async function login(phone: string): Promise<string> {
    const reqRes = await fetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) })
    const reqBody = await reqRes.json() as { data: { devCode?: string } }
    if (!reqBody.data?.devCode) throw new Error(`Нет devCode для ${phone}`)
    const verifyRes = await fetch(`${BASE}/api/v1/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code: reqBody.data.devCode }) })
    if (!verifyRes.ok) throw new Error(`verify ${phone} → ${verifyRes.status}`)
    return verifyRes.headers.getSetCookie().map(c => c.split(';')[0]!).join('; ')
  }
  const post = (body: unknown) => fetch(`${BASE}/api/v1/media/upload-url`, {
    method: 'POST',
    headers: { 'cookie': cookie, 'x-csrf-token': cookie.split('; ').find(c => c.startsWith('lola_csrf='))?.split('=')[1] ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  beforeAll(async () => {
    await admin`delete from rate_limits where key like ${'otp:%'}`
    await admin`delete from otp_codes where phone = ${EMPLOYEE_PHONE}`
    server = spawn('node', ['.output/server/index.mjs'], {
      env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), OTP_DEBUG: '1', NUXT_DATABASE_URL: process.env.DATABASE_URL, WORKER_ENABLED: '0' },
      stdio: 'ignore',
    })
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) break
      }
      catch { /* ещё поднимается */ }
      await new Promise(r => setTimeout(r, 500))
    }
    cookie = await login(EMPLOYEE_PHONE)
    await setStorageOverride(1)
    await makeMedia({ origin: 'import', bytes: 1_200_000_000 })
  }, 60_000)

  afterAll(async () => {
    server?.kill()
    await setStorageOverride(null)
  })

  beforeEach(async () => {
    await admin`delete from rate_limits where key like ${'otp:%'}`
  })

  it('своя работа при заполненном хранилище — 202 {deferred: true}', async () => {
    const res = await post({ filename: 'a.webm', mime: 'video/webm', bytes: 100, origin: 'workshop_submission', clientRef: `dev:v2-36-http-${stamp}` })
    expect(res.status).toBe(202)
    const body = await res.json() as { data: { deferred: boolean, pendingId: string } }
    expect(body.data.deferred).toBe(true)
    expect(body.data.pendingId).toMatch(/^[\da-f-]{36}$/)
  })

  it('без ключа устройства — прежний 400 media.storage_limit', async () => {
    const res = await post({ filename: 'a.webm', mime: 'video/webm', bytes: 100, origin: 'workshop_submission' })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('media.storage_limit')
  })

  it('контент (обложка) сотруднику без media.upload — 403', async () => {
    const res = await post({ filename: 'c.png', mime: 'image/png', bytes: 100, origin: 'content_cover' })
    expect(res.status).toBe(403)
  })
})
