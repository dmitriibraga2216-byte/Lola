import { sql } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import type { MediaOrigin, StoragePendingUploadStatus } from '../../shared/enums'
import { formatBytes } from '../../shared/domain/dateFormat'
import { checkLimit } from './tenantLimits'
import { storageAdmins, storageUsedBytes } from './storage'
import { enqueueNotification } from './notifications'

/**
 * Отложенная загрузка (docs/v2/34 §7.5, §13 к. 1; план docs/v2/45 PR-36).
 *
 * Инвариант, унаследованный из `25` §10 и не подлежащий пересмотру: **обучение никогда не
 * останавливается лимитами — блокируются только загрузки**. Сотрудник, упёршийся в
 * исчерпанную квоту тенанта, не теряет ни попытку, ни записанное видео, ни срок:
 *
 *  1. `POST /media/upload-url` с `clientRef` при исчерпанной квоте отвечает не отказом, а
 *     `{deferred: true, pendingId}` (решение В-17: вход загрузки один, отдельного
 *     `upload-intent` нет). Запись остаётся на устройстве под `clientRef`, здесь — строка
 *     `waiting` на 14 дней; администратору — `storage_upload_blocked`, сотруднику —
 *     `storage_upload_deferred`.
 *  2. Сдача уходит в `submitted` с файлом-обещанием `{pendingId}`: срок засчитан по времени
 *     записи, в очереди ментора работа видна с меткой «Очікує вивантаження», взять её нельзя.
 *  3. `storage.pending_upload_retry` (каждые 15 минут и при освобождении места) выдаёт место
 *     FIFO: `waiting → uploading`. Устройство при следующем обращении получает ссылку, досылает
 *     файл, подтверждение переводит строку в `done` — сдача теряет метку и попадает к ментору,
 *     сотруднику — `storage_pending_upload_done`.
 *  4. По `expires_at` — `abandoned`, уведомление обоим; сдача остаётся зачтённой с пометкой
 *     «Файл втрачено»: это вина тенанта, не сотрудника.
 *
 * Лимит здесь не считается: «пройдёт ли» решает `checkLimit()` из `tenantLimits.ts` с допуском
 * для начатых загрузок, факт — счётчик `storage_usage_counters`.
 */

export interface Ctx { tenantId: string, actorId: string }

/** Срок жизни отложенной загрузки (§7.5 п. 1): 14 дней. */
export const PENDING_UPLOAD_TTL_DAYS = 14

export interface PendingUploadRow {
  id: string
  userId: string
  status: StoragePendingUploadStatus
  origin: MediaOrigin
  sourceEntity: string
  sourceId: string | null
  enrollmentId: string | null
  declaredBytes: number
  clientRef: string
  mediaId: string | null
  attempts: number
  expiresAt: string
  createdAt: string
}

type Raw = {
  id: string, user_id: string, status: string, origin: string, source_entity: string, source_id: string | null
  enrollment_id: string | null, declared_bytes: string | number, client_ref: string, media_id: string | null
  attempts: number, expires_at: Date | string, created_at: Date | string
}

const toRow = (r: Raw): PendingUploadRow => ({
  id: r.id,
  userId: r.user_id,
  status: r.status as StoragePendingUploadStatus,
  origin: r.origin as MediaOrigin,
  sourceEntity: r.source_entity,
  sourceId: r.source_id,
  enrollmentId: r.enrollment_id,
  declaredBytes: Number(r.declared_bytes),
  clientRef: r.client_ref,
  mediaId: r.media_id,
  attempts: r.attempts,
  expiresAt: new Date(r.expires_at).toISOString(),
  createdAt: new Date(r.created_at).toISOString(),
})

/** Отложенная загрузка этого человека под этим ключом устройства — если она есть. */
export async function pendingByClientRef(tx: TenantTx, userId: string, clientRef: string): Promise<PendingUploadRow | null> {
  const [r] = await tx.execute(sql`
    select * from storage_pending_uploads where user_id = ${userId}::uuid and client_ref = ${clientRef} for update
  `) as unknown as Raw[]
  return r ? toRow(r) : null
}

export interface DeferInput {
  clientRef: string
  origin: MediaOrigin
  sourceEntity?: string
  sourceId?: string
  enrollmentId?: string
  bytes: number
}

/**
 * Завести (или вернуть уже заведённую) отложенную загрузку — идемпотентно по
 * `(tenant, user, client_ref)`: повтор запроса с того же устройства не плодит строк и
 * уведомлений.
 */
export async function deferUpload(ctx: Ctx, input: DeferInput): Promise<PendingUploadRow> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.execute(sql`
      insert into storage_pending_uploads (tenant_id, user_id, enrollment_id, source_entity, source_id, origin, declared_bytes, client_ref, status, expires_at)
      values (${ctx.tenantId}::uuid, ${ctx.actorId}::uuid, ${input.enrollmentId ?? null}::uuid, ${input.sourceEntity ?? 'media_assets'},
              ${input.sourceId ?? null}::uuid, ${input.origin}, ${input.bytes}, ${input.clientRef}, 'waiting',
              now() + make_interval(days => ${PENDING_UPLOAD_TTL_DAYS}))
      on conflict (tenant_id, user_id, client_ref) do update set declared_bytes = excluded.declared_bytes
      returning *, (xmax = 0) as inserted
    `) as unknown as (Raw & { inserted: boolean })[]
    const row = toRow(r!)
    if (r!.inserted) await notifyDeferred(tx, ctx.tenantId, row)
    return row
  })
}

async function waitingTotals(tx: TenantTx): Promise<{ n: number, bytes: number }> {
  const [t] = await tx.execute(sql`
    select count(*)::int as n, coalesce(sum(declared_bytes), 0)::bigint as bytes
      from storage_pending_uploads where status in ('waiting', 'uploading')
  `) as unknown as { n: number, bytes: string | number }[]
  return { n: t?.n ?? 0, bytes: Number(t?.bytes ?? 0) }
}

/**
 * Сотруднику — «Відповідь збережено. Файл відправиться автоматично» (`storage_upload_deferred`),
 * администраторам — «{n} відповідей співробітників очікують вивантаження ({size})»
 * (`storage_upload_blocked`, раз в сутки на администратора: число и объём — на момент первой).
 */
async function notifyDeferred(tx: TenantTx, tenantId: string, row: PendingUploadRow): Promise<void> {
  await enqueueNotification(tx, {
    tenantId,
    userId: row.userId,
    code: 'storage_upload_deferred',
    payload: { pendingId: row.id },
    dedupKey: `storage_upload_deferred:${row.id}`,
    refType: 'storage_pending_uploads',
    refId: row.id,
  })
  const totals = await waitingTotals(tx)
  const day = new Date().toISOString().slice(0, 10)
  for (const adminId of await storageAdmins(tx)) {
    await enqueueNotification(tx, {
      tenantId,
      userId: adminId,
      code: 'storage_upload_blocked',
      payload: { n: totals.n, size: formatBytes(totals.bytes, 'uk') },
      dedupKey: `storage_upload_blocked:${tenantId}:${day}:${adminId}`,
    })
  }
}

/**
 * Выдать место отложенной загрузке, если оно есть: `waiting → uploading`. Место считает
 * `checkLimit()` с допуском (§7.5): к занятому по счётчику прибавляются уже выданные, но ещё
 * не дошедшие загрузки — иначе одно и то же свободное место досталось бы нескольким.
 */
async function reserved(tx: TenantTx, exceptId?: string): Promise<number> {
  const [r] = await tx.execute(sql`
    select coalesce(sum(declared_bytes), 0)::bigint as n from storage_pending_uploads
     where status = 'uploading' and media_id is null ${exceptId ? sql`and id <> ${exceptId}::uuid` : sql``}
  `) as unknown as { n: string | number }[]
  return Number(r?.n ?? 0)
}

export async function tryGrant(tx: TenantTx, tenantId: string, row: PendingUploadRow): Promise<boolean> {
  if (row.status !== 'waiting') return row.status === 'uploading'
  const used = await storageUsedBytes(tenantId, tx) + await reserved(tx, row.id)
  const check = await checkLimit(tenantId, 'storage_bytes', used, row.declaredBytes, { withGrace: true })
  if (!check.ok) return false
  await tx.execute(sql`
    update storage_pending_uploads set status = 'uploading', attempts = attempts + 1, last_error = null
     where id = ${row.id}::uuid and status = 'waiting'
  `)
  row.status = 'uploading'
  return true
}

/** Файл, заведённый под отложенную загрузку, — связь для подтверждения (`media/:id/complete`). */
export async function linkPendingMedia(tx: TenantTx, pendingId: string, mediaId: string): Promise<void> {
  await tx.execute(sql`update storage_pending_uploads set media_id = ${mediaId}::uuid where id = ${pendingId}::uuid`)
}

export interface RetryReport { granted: number, abandoned: number }

/**
 * `storage.pending_upload_retry` (§7.5 п. 3, §11: каждые 15 минут): сначала — просроченные
 * в `abandoned` (уведомление сотруднику и администраторам, сдача — «Файл втрачено»), затем
 * выдача места ожидающим **в порядке очереди**: первая не поместившаяся останавливает проход —
 * меньшая поздняя запись не обгоняет раннюю большую.
 */
export async function pendingUploadRetry(tenantId: string, now: Date = new Date()): Promise<RetryReport> {
  return withTenant(tenantId, null, async (tx) => {
    const expired = await tx.execute(sql`
      update storage_pending_uploads set status = 'abandoned', last_error = 'expired'
       where status in ('waiting', 'uploading') and expires_at <= ${now.toISOString()}::timestamptz
      returning *
    `) as unknown as Raw[]
    if (expired.length) {
      const { markPendingFileLost } = await import('./workshops')
      const admins = await storageAdmins(tx)
      for (const raw of expired) {
        const row = toRow(raw)
        const task = await markPendingFileLost(tx, tenantId, row.userId, row.id)
        for (const userId of [row.userId, ...admins]) {
          await enqueueNotification(tx, {
            tenantId,
            userId,
            code: 'storage_pending_upload_expired',
            payload: { task: task ?? '', pendingId: row.id },
            dedupKey: `storage_pending_upload_expired:${row.id}:${userId}`,
            refType: 'storage_pending_uploads',
            refId: row.id,
          })
        }
      }
    }

    const waiting = (await tx.execute(sql`
      select * from storage_pending_uploads where status = 'waiting' order by created_at, id for update skip locked
    `) as unknown as Raw[]).map(toRow)
    let granted = 0
    for (const row of waiting) {
      if (!await tryGrant(tx, tenantId, row)) break
      granted++
    }
    return { granted, abandoned: expired.length }
  })
}

/**
 * Подтверждение загрузки (`POST /media/:id/complete`) для файла отложенной записи: строка —
 * в `done`, файл-обещание в сдаче заменяется настоящим, сдача без других ожидающих файлов
 * уходит ментору, сотруднику — `storage_pending_upload_done`. Не отложенный файл — `null`.
 */
export async function completePendingUpload(tx: TenantTx, tenantId: string, mediaId: string): Promise<PendingUploadRow | null> {
  const [raw] = await tx.execute(sql`
    update storage_pending_uploads set status = 'done', last_error = null
     where media_id = ${mediaId}::uuid and status = 'uploading'
    returning *
  `) as unknown as Raw[]
  if (!raw) return null
  const row = toRow(raw)
  const { attachPendingFile } = await import('./workshops')
  const task = await attachPendingFile(tx, tenantId, row.userId, row.id, mediaId)
  await enqueueNotification(tx, {
    tenantId,
    userId: row.userId,
    code: 'storage_pending_upload_done',
    payload: { task: task ?? '', pendingId: row.id },
    dedupKey: `storage_pending_upload_done:${row.id}`,
    refType: 'storage_pending_uploads',
    refId: row.id,
  })
  return row
}

/**
 * Внеочередной проход (§7.5 п. 4, §11 «и при освобождении места»): место появилось — опция
 * `storage_pack`, переопределение оператора, удаление файлов. Ждать до 15 минут незачем, а
 * проход дешёвый; если ждущих нет — не делается ничего. Сбой не роняет операцию, которая
 * место освободила: задача по расписанию всё равно подберёт очередь.
 */
export async function kickPendingUploads(tenantId: string): Promise<RetryReport | null> {
  try {
    const waiting = await withTenant(tenantId, null, async (tx) => {
      const [r] = await tx.execute(sql`select exists (select 1 from storage_pending_uploads where status = 'waiting') as waiting`) as unknown as { waiting: boolean }[]
      return r?.waiting ?? false
    })
    return waiting ? await pendingUploadRetry(tenantId) : null
  }
  catch {
    return null
  }
}

/** `GET /storage/pending-uploads` (§10) — отложенные загрузки с устройств, для администратора. */
export async function listPendingUploads(ctx: Ctx): Promise<(PendingUploadRow & { userName: string | null })[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select p.*, u.full_name as user_name from storage_pending_uploads p
        left join users u on u.id = p.user_id
       where p.status in ('waiting', 'uploading')
       order by p.created_at
       limit 500
    `) as unknown as (Raw & { user_name: string | null })[]
    return rows.map(r => ({ ...toRow(r), userName: r.user_name }))
  })
}
