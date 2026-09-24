import { sql } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import type { StorageDeletionMode, StorageDeletionStatus, StorageSkipReason } from '../../shared/enums'
import { STORAGE_CONFIRM_PHRASE } from '../../shared/schemas/storage'
import type { StorageDeletionConfirm, StorageDeletionCreate } from '../../shared/schemas/storage'
import { formatBytes } from '../../shared/domain/dateFormat'
import { filesWhere, mediaHeldByLibrary, mediaUnderReview, notDeletableReason, textArray } from './storage'
import { trashDaysFor } from './storagePolicies'
import { kickPendingUploads } from './storagePending'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'

/**
 * Массовое удаление — только заявкой (docs/v2/34 §3.3, §6.1, §12, §13 к. 4; решение
 * docs/v2/44 В-17: обходного `DELETE /storage/files` с `{ids[]}` нет). Заявка — это и есть
 * ответ на вопрос «кто снёс доказательства за прошлый квартал»: снимок выборки, число
 * доказательств, причина и фраза подтверждения, что пропущено и почему.
 *
 * Удаление — мягкое: файл уходит в корзину на срок из политики хранения (`trash_days`,
 * docs/v2/44 §8), объект в S3 остаётся, счётчик квоты уменьшается сразу (триггер).
 */

export interface Ctx { tenantId: string, actorId: string }

/** Выборка «по фильтру» больше этого — не заявка, а политика хранения (§7.3). */
export const DELETION_MAX_FILES = 5000
/** Партия исполнения заявки (§11: `storage.bulk_delete` — партиями по 200 файлов). */
export const DELETION_BATCH = 200

export interface DeletionRequestView {
  id: string
  mode: StorageDeletionMode
  status: StorageDeletionStatus
  plannedFiles: number
  plannedBytes: number
  evidenceCount: number
  /** Сколько файлов из выборки заведомо будет пропущено (сертификаты, сдачи на проверке). */
  notDeletableCount: number
  deletedFiles: number
  deletedBytes: number
  skipped: { mediaId: string, reason: StorageSkipReason }[]
  createdAt: string
  finishedAt: string | null
}

type ReqRow = {
  id: string, mode: string, status: string, planned_files: number, planned_bytes: string | number, evidence_count: number
  media_ids: string[], deleted_files: number, deleted_bytes: string | number, skipped: { mediaId: string, reason: StorageSkipReason }[]
  created_at: Date | string, finished_at: Date | string | null, reason: string | null, requested_by: string | null
}

const view = (r: ReqRow, notDeletableCount = 0): DeletionRequestView => ({
  id: r.id,
  mode: r.mode as StorageDeletionMode,
  status: r.status as StorageDeletionStatus,
  plannedFiles: r.planned_files,
  plannedBytes: Number(r.planned_bytes),
  evidenceCount: r.evidence_count,
  notDeletableCount,
  deletedFiles: r.deleted_files,
  deletedBytes: Number(r.deleted_bytes),
  skipped: r.skipped ?? [],
  createdAt: new Date(r.created_at).toISOString(),
  finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
})

type MediaRow = { id: string, bytes: number, origin: string, is_evidence: boolean, lifecycle: string }

/** Что из выборки будет удалено, а что пропущено — одна функция для черновика и для исполнения. */
async function classify(tx: TenantTx, rows: MediaRow[]) {
  const underReview = await mediaUnderReview(tx, rows.map(r => r.id))
  const held = await mediaHeldByLibrary(tx, rows.map(r => r.id))
  const planned: MediaRow[] = []
  const skipped: { mediaId: string, reason: StorageSkipReason }[] = []
  for (const r of rows) {
    if (r.lifecycle === 'pending_delete' || r.lifecycle === 'purged') { skipped.push({ mediaId: r.id, reason: 'already_deleted' }); continue }
    const reason = notDeletableReason(r, underReview.has(r.id), held.has(r.id))
    if (reason) { skipped.push({ mediaId: r.id, reason }); continue }
    planned.push(r)
  }
  return { planned, skipped }
}

export type CreateDeletionResult
  = | { ok: true, request: DeletionRequestView }
    | { ok: false, code: 'empty' | 'too_many' }

/**
 * `POST /storage/deletions` (§10): черновик заявки со снимком выборки и подсчётом —
 * «Обрано {n} файлів · {size}», «Серед них {k} файлів є доказом проходження» (§6.1).
 * Чужие идентификаторы в выборке просто не находятся под RLS — ни ошибки, ни утечки.
 */
export async function createDeletionRequest(ctx: Ctx, input: StorageDeletionCreate): Promise<CreateDeletionResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = input.mode === 'selection'
      ? await tx.execute(sql`
          select id, bytes, origin, is_evidence, lifecycle from media_assets where id::text = any(${textArray(input.mediaIds)})
        `) as unknown as MediaRow[]
      : await tx.execute(sql`
          select m.id, m.bytes, m.origin, m.is_evidence, m.lifecycle from media_assets m
           where ${filesWhere(input.filter)} order by m.created_at desc limit ${DELETION_MAX_FILES + 1}
        `) as unknown as MediaRow[]
    if (!rows.length) return { ok: false as const, code: 'empty' as const }
    if (rows.length > DELETION_MAX_FILES) return { ok: false as const, code: 'too_many' as const }

    const { planned, skipped } = await classify(tx, rows)
    const [req] = await tx.execute(sql`
      insert into storage_deletion_requests (tenant_id, requested_by, mode, filter, media_ids, planned_files, planned_bytes, evidence_count, status)
      values (${ctx.tenantId}::uuid, ${ctx.actorId}::uuid, ${input.mode},
              ${JSON.stringify(input.mode === 'filter' ? input.filter : {})}::jsonb,
              ${sql`array[${sql.join(rows.map(r => sql`${r.id}::uuid`), sql`, `)}]::uuid[]`},
              ${planned.length}, ${planned.reduce((s, r) => s + Number(r.bytes), 0)}, ${planned.filter(r => r.is_evidence).length}, 'draft')
      returning *
    `) as unknown as ReqRow[]
    return { ok: true as const, request: view(req!, skipped.filter(s => s.reason !== 'already_deleted').length) }
  })
}

export async function getDeletionRequest(ctx: Ctx, id: string): Promise<DeletionRequestView | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.execute(sql`select * from storage_deletion_requests where id = ${id}::uuid`) as unknown as ReqRow[]
    return r ? view(r) : null
  })
}

export type ConfirmDeletionResult
  = | { ok: true, request: DeletionRequestView }
    | { ok: false, code: 'not_found' | 'not_draft' | 'reason_required' | 'confirm_phrase_mismatch' }

/**
 * `POST /storage/deletions/:id/confirm` (§6.1, §10) — подтверждение и исполнение.
 *
 * Причина (10–500) и слово «ВИДАЛИТИ» обязательны, если среди удаляемого есть доказательства.
 * Число доказательств **пересчитывается** в момент подтверждения, а не берётся из черновика:
 * между черновиком и подтверждением ментор мог выставить оценку, и файл стал доказательством —
 * подтверждение по старому подсчёту снесло бы его без фразы.
 *
 * Исполняется сразу, партиями по 200: сертификат пропускается с `not_deletable`, уже
 * удалённое — с `already_deleted` (второй администратор, удаливший ту же выборку, получает
 * это в `skipped`, счётчик уменьшается один раз, §12), сдача на проверке — с `under_review`.
 * Одна запись `storage.bulk_delete` в `audit_log` на заявку (§7.2 п. 4).
 */
export async function confirmDeletionRequest(ctx: Ctx, id: string, input: StorageDeletionConfirm): Promise<ConfirmDeletionResult> {
  const result = await withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<ConfirmDeletionResult> => {
    const [req] = await tx.execute(sql`select * from storage_deletion_requests where id = ${id}::uuid for update`) as unknown as ReqRow[]
    if (!req) return { ok: false, code: 'not_found' }
    if (req.status !== 'draft') return { ok: false, code: 'not_draft' }

    const ids = req.media_ids ?? []
    const current = ids.length
      ? await tx.execute(sql`select id, bytes, origin, is_evidence, lifecycle from media_assets where id::text = any(${textArray(ids)}) for update`) as unknown as MediaRow[]
      : []
    const { planned } = await classify(tx, current)
    const evidence = planned.filter(r => r.is_evidence).length
    const reason = input.reason?.trim() ?? ''
    if (evidence > 0) {
      if (reason.length < 10 || reason.length > 500) return { ok: false, code: 'reason_required' }
      if (input.confirmPhrase !== STORAGE_CONFIRM_PHRASE) return { ok: false, code: 'confirm_phrase_mismatch' }
    }
    await tx.execute(sql`
      update storage_deletion_requests
         set status = 'running', confirmed_at = now(), evidence_count = ${evidence},
             reason = ${reason.length >= 10 ? reason : null}, confirm_phrase = ${input.confirmPhrase ?? null}
       where id = ${id}::uuid
    `)

    let deletedFiles = 0
    let deletedBytes = 0
    const skipped: { mediaId: string, reason: StorageSkipReason }[] = []
    const trashDays = new Map<string, number>()
    for (let i = 0; i < ids.length; i += DELETION_BATCH) {
      const inBatch = new Set(ids.slice(i, i + DELETION_BATCH))
      const batch = current.filter(r => inBatch.has(r.id))
      const c = await classify(tx, batch)
      skipped.push(...c.skipped)
      for (const r of c.planned) {
        if (!trashDays.has(r.origin)) trashDays.set(r.origin, await trashDaysFor(tx, ctx.tenantId, r.origin))
        // `where lifecycle in (active, orphaned)` — повтор после сбоя не переудаляет удалённое (§4)
        const done = await tx.execute(sql`
          update media_assets
             set lifecycle = 'pending_delete', deleted_at = now(), deleted_by = ${ctx.actorId}::uuid,
                 delete_reason = ${reason.length >= 10 ? reason : null},
                 purge_after = now() + make_interval(days => ${trashDays.get(r.origin)!}::int), updated_at = now()
           where id = ${r.id}::uuid and lifecycle in ('active', 'orphaned')
          returning id
        `) as unknown as { id: string }[]
        if (done.length) { deletedFiles++; deletedBytes += Number(r.bytes) }
        else skipped.push({ mediaId: r.id, reason: 'already_deleted' })
      }
    }
    // Идентификаторы выборки, которых уже нет в реестре тенанта, — тоже «уже удалено»
    const seen = new Set(current.map(r => r.id))
    for (const mediaId of ids) if (!seen.has(mediaId)) skipped.push({ mediaId, reason: 'already_deleted' })

    const [done] = await tx.execute(sql`
      update storage_deletion_requests
         set status = 'done', finished_at = now(), deleted_files = ${deletedFiles}, deleted_bytes = ${deletedBytes},
             skipped = ${JSON.stringify(skipped)}::jsonb
       where id = ${id}::uuid
      returning *
    `) as unknown as ReqRow[]
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'storage.bulk_delete',
      entity: 'storage_deletion_requests',
      entityId: id,
      after: { mode: req.mode, deletedFiles, deletedBytes, evidenceCount: evidence, reason: reason || null, skipped },
    })
    await enqueueNotification(tx, {
      tenantId: ctx.tenantId,
      userId: ctx.actorId,
      code: 'storage_bulk_delete_done',
      payload: { n: deletedFiles, size: formatBytes(deletedBytes, 'uk'), skipped: skipped.length, requestId: id },
      dedupKey: `storage_bulk_delete_done:${id}`,
    })
    return { ok: true, request: view(done!) }
  })
  // Место освободилось — отложенные записи сотрудников досылаются сразу (§7.5, §11)
  if (result.ok && result.request.deletedFiles > 0) await kickPendingUploads(ctx.tenantId)
  return result
}

export type CancelDeletionResult = { ok: true } | { ok: false, code: 'not_found' | 'not_draft' }

/** `POST /storage/deletions/:id/cancel` — только до подтверждения (§4: ветка `cancelled`). */
export async function cancelDeletionRequest(ctx: Ctx, id: string): Promise<CancelDeletionResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [req] = await tx.execute(sql`select status from storage_deletion_requests where id = ${id}::uuid for update`) as unknown as { status: string }[]
    if (!req) return { ok: false as const, code: 'not_found' as const }
    if (req.status !== 'draft') return { ok: false as const, code: 'not_draft' as const }
    await tx.execute(sql`update storage_deletion_requests set status = 'cancelled', finished_at = now() where id = ${id}::uuid`)
    return { ok: true as const }
  })
}
