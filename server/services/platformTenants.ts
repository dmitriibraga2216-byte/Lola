import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { desc, eq, sql } from 'drizzle-orm'
import { platformAudit, tenantLimits, tenants } from '../db/schema'
import { currentRequestContext } from '../utils/requestContext'
import { platformDb, type PlatformAuth } from './platform'
import { invalidateTenant } from './tenantResolve'
import { invalidateLimits } from './tenantLimits'
import { enqueueForTenant } from './tenantQueue'
import type { TenantLimitsInput } from '../../shared/schemas/platform'

/**
 * Жизненный цикл тенанта в панели оператора (docs/25 §7, §8; docs/24 §7 п. 5, §10):
 * suspend → вход закрыт, задачи стоят, данные целы; purge — только из suspended, по явной команде с подтверждением
 * slug, исполняется задачей `tenant.purge` через TENANT_PURGE_DELAY_DAYS (30) дней; до этого отменяется.
 * Каждое действие — в `platform_audit` с `request_context` (docs/25 §7 п. 5, CLAUDE.md п. 14).
 * Работает только под PLATFORM_DATABASE_URL; `update tenants` — всегда `where id = tenantId`.
 */

export const PURGE_DELAY_DAYS = () => Number(process.env.TENANT_PURGE_DELAY_DAYS || 30)
export const PURGE_QUEUE = 'tenant.purge'

// ── platform_audit ────────────────────────────────────────────────────

export interface PlatformAuditInput {
  action: string
  tenantId?: string | null
  entity: string
  entityId?: string | null
  before?: unknown
  after?: unknown
}

export async function recordPlatformAudit(actor: PlatformAuth, input: PlatformAuditInput): Promise<void> {
  await platformDb().insert(platformAudit).values({
    adminId: actor.adminId,
    adminEmail: actor.email,
    action: input.action,
    subjectTenantId: input.tenantId ?? null,
    entity: input.entity,
    entityId: input.entityId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    requestContext: currentRequestContext(),
  })
}

export async function listPlatformAudit(filter: { tenantId?: string, limit?: number } = {}) {
  const db = platformDb()
  const q = db.select().from(platformAudit).orderBy(desc(platformAudit.createdAt)).limit(Math.min(filter.limit ?? 100, 500))
  const rows = filter.tenantId ? await q.where(eq(platformAudit.subjectTenantId, filter.tenantId)) : await q
  return rows.map(r => ({ ...r, id: String(r.id) }))
}

// ── Статусы ───────────────────────────────────────────────────────────

export type TenantActionResult = { ok: true, status: string, archivedAt: string | null, purgeAt: string | null }
  | { ok: false, code: 'not_found' | 'wrong_status' | 'confirm_mismatch' }

async function loadTenant(id: string) {
  const [t] = await platformDb().select().from(tenants).where(eq(tenants.id, id))
  return t ?? null
}

export function purgeAtOf(archivedAt: Date | null): Date | null {
  return archivedAt ? new Date(archivedAt.getTime() + PURGE_DELAY_DAYS() * 86_400_000) : null
}

const view = (t: { status: string, archivedAt: Date | null }): TenantActionResult => ({ ok: true, status: t.status, archivedAt: t.archivedAt?.toISOString() ?? null, purgeAt: purgeAtOf(t.archivedAt)?.toISOString() ?? null })

/**
 * Приостановка (docs/25 §8): только статус — сессии не трогаем, они получают 403 `tenant_suspended` на каждый запрос
 * и оживают после resume; приложение узнаёт сразу (кеш статуса сброшен).
 */
export async function suspendTenant(id: string, reason: string | null, actor: PlatformAuth): Promise<TenantActionResult> {
  const t = await loadTenant(id)
  if (!t) return { ok: false, code: 'not_found' }
  if (t.status !== 'active') return { ok: false, code: 'wrong_status' }
  const db = platformDb()
  const [after] = await db.update(tenants).set({ status: 'suspended', updatedAt: new Date() }).where(eq(tenants.id, id)).returning()
  await recordPlatformAudit(actor, { action: 'tenant.suspend', tenantId: id, entity: 'tenant', entityId: id, before: { status: t.status }, after: { status: 'suspended', reason, slug: t.slug } })
  invalidateTenant(id)
  return view(after!)
}

/** Возобновление из suspended. */
export async function resumeTenant(id: string, actor: PlatformAuth): Promise<TenantActionResult> {
  const t = await loadTenant(id)
  if (!t) return { ok: false, code: 'not_found' }
  if (t.status !== 'suspended') return { ok: false, code: 'wrong_status' }
  const [after] = await platformDb().update(tenants).set({ status: 'active', updatedAt: new Date() }).where(eq(tenants.id, id)).returning()
  await recordPlatformAudit(actor, { action: 'tenant.resume', tenantId: id, entity: 'tenant', entityId: id, before: { status: t.status }, after: { status: 'active', slug: t.slug } })
  invalidateTenant(id)
  return view(after!)
}

/**
 * Команда на удаление (docs/25 §8, docs/24 §7 п. 5): только из suspended, оператор подтверждает slug.
 * Ставится `tenant.purge` со стартом через 30 дней; статус archived + archived_at — мягкое удаление.
 */
export async function schedulePurge(id: string, confirmSlug: string, actor: PlatformAuth): Promise<TenantActionResult> {
  const t = await loadTenant(id)
  if (!t) return { ok: false, code: 'not_found' }
  if (t.status !== 'suspended') return { ok: false, code: 'wrong_status' }
  if (confirmSlug !== t.slug) return { ok: false, code: 'confirm_mismatch' }
  const archivedAt = new Date()
  const [after] = await platformDb().update(tenants).set({ status: 'archived', archivedAt, updatedAt: archivedAt }).where(eq(tenants.id, id)).returning()
  const purgeAt = purgeAtOf(archivedAt)!
  const jobId = await enqueueForTenant(PURGE_QUEUE, id, {}, { singletonKey: `purge:${id}`, startAfter: purgeAt }).catch((err) => {
    console.error('[tenant.purge] не удалось поставить задачу', err)
    return null
  })
  await recordPlatformAudit(actor, { action: 'tenant.purge_schedule', tenantId: id, entity: 'tenant', entityId: id, before: { status: t.status }, after: { status: 'archived', slug: t.slug, purgeAt: purgeAt.toISOString(), jobId } })
  invalidateTenant(id)
  return view(after!)
}

/** Отмена до срока: archived → suspended, задача снимается. */
export async function cancelPurge(id: string, actor: PlatformAuth): Promise<TenantActionResult> {
  const t = await loadTenant(id)
  if (!t) return { ok: false, code: 'not_found' }
  if (t.status !== 'archived') return { ok: false, code: 'wrong_status' }
  const db = platformDb()
  const [after] = await db.update(tenants).set({ status: 'suspended', archivedAt: null, updatedAt: new Date() }).where(eq(tenants.id, id)).returning()
  const [last] = await db.select({ after: platformAudit.after }).from(platformAudit)
    .where(sql`${platformAudit.subjectTenantId} = ${id} and ${platformAudit.action} = 'tenant.purge_schedule'`).orderBy(desc(platformAudit.createdAt)).limit(1)
  const jobId = (last?.after as { jobId?: string } | null)?.jobId
  if (jobId) {
    const { getBoss } = await import('./queue')
    await getBoss().then(b => b.cancel(PURGE_QUEUE, jobId)).catch(err => console.error('[tenant.purge] отмена задачи', err))
  }
  await recordPlatformAudit(actor, { action: 'tenant.purge_cancel', tenantId: id, entity: 'tenant', entityId: id, before: { status: t.status, archivedAt: t.archivedAt }, after: { status: 'suspended', slug: t.slug, jobId: jobId ?? null } })
  invalidateTenant(id)
  return view(after!)
}

// ── Лимиты ────────────────────────────────────────────────────────────

export async function getTenantLimits(id: string) {
  const db = platformDb()
  const t = await loadTenant(id)
  if (!t) return null
  const [o] = await db.select().from(tenantLimits).where(eq(tenantLimits.tenantId, id))
  const [p] = await db.execute(sql`select max_users, max_storage_gb, max_sms_per_month from plans where code = ${t.plan}`) as unknown as { max_users: number | null, max_storage_gb: number | null, max_sms_per_month: number | null }[]
  return {
    plan: { code: t.plan, users: p?.max_users ?? null, storageGb: p?.max_storage_gb ?? null, smsPerMonth: p?.max_sms_per_month ?? null },
    overrides: { users: o?.users ?? null, storageGb: o?.storageGb ?? null, smsPerMonth: o?.smsPerMonth ?? null, apiPerMinute: o?.apiPerMinute ?? null, webhooks: o?.webhooks ?? null, activeJobs: o?.activeJobs ?? null },
  }
}

/** Переопределение лимитов (docs/24 §4.4): null — вернуться к тарифу; все null — строка удаляется. */
export async function setTenantLimits(id: string, input: TenantLimitsInput, actor: PlatformAuth) {
  const before = await getTenantLimits(id)
  if (!before) return null
  const db = platformDb()
  const values = { users: input.users ?? null, storageGb: input.storageGb ?? null, smsPerMonth: input.smsPerMonth ?? null, apiPerMinute: input.apiPerMinute ?? null, webhooks: input.webhooks ?? null, activeJobs: input.activeJobs ?? null }
  if (Object.values(values).every(v => v === null)) {
    await db.delete(tenantLimits).where(eq(tenantLimits.tenantId, id))
  }
  else {
    await db.insert(tenantLimits).values({ tenantId: id, ...values, updatedBy: actor.adminId })
      .onConflictDoUpdate({ target: tenantLimits.tenantId, set: { ...values, updatedBy: actor.adminId, updatedAt: new Date() } })
  }
  await recordPlatformAudit(actor, { action: 'tenant.limits', tenantId: id, entity: 'tenant_limits', entityId: id, before: before.overrides, after: values })
  invalidateLimits(id)
  return getTenantLimits(id)
}

// ── Purge ─────────────────────────────────────────────────────────────

export interface PurgeReport {
  tenantId: string
  slug: string
  tables: Record<string, number>
  passes: number
  s3: { deleted: number, error: string | null }
  durationMs: number
}

const BATCH = 5000

/** Таблицы с tenant_id (docs/25 §3.1) — всё, что принадлежит тенанту. */
async function tenantTables(): Promise<string[]> {
  const rows = await platformDb().execute(sql`
    select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
    order by c.relname`) as unknown as { t: string }[]
  return rows.map(r => r.t)
}

async function deleteS3Prefix(prefix: string): Promise<{ deleted: number, error: string | null }> {
  try {
    const { s3, S3_BUCKET } = await import('./media')
    const client = s3()
    let deleted = 0
    let token: string | undefined
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: S3_BUCKET(), Prefix: prefix, ContinuationToken: token }))
      const keys = (page.Contents ?? []).map(o => ({ Key: o.Key! }))
      if (keys.length) {
        await client.send(new DeleteObjectsCommand({ Bucket: S3_BUCKET(), Delete: { Objects: keys, Quiet: true } }))
        deleted += keys.length
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    return { deleted, error: null }
  }
  catch (err) {
    return { deleted: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Необратимое удаление данных тенанта (docs/25 §8): партиями по BATCH строк, таблицы — в порядке зависимостей
 * (таблица, которую ещё держит внешний ключ, откладывается на следующий проход), затем строка `tenants`,
 * затем S3-префикс `t/<tenant_id>/`. Отчёт — в `platform_audit` (`tenant.purged`, subject_tenant_id уже null).
 */
export async function purgeTenantData(tenantId: string, actor: PlatformAuth | null = null): Promise<PurgeReport> {
  const started = Date.now()
  const db = platformDb()
  const t = await loadTenant(tenantId)
  if (!t) throw new Error(`tenant ${tenantId} не найден`)
  const tables: Record<string, number> = {}
  let pending = await tenantTables()
  let passes = 0
  while (pending.length && passes < 20) {
    passes++
    const next: string[] = []
    for (const table of pending) {
      try {
        let total = tables[table] ?? 0
        for (;;) {
          const rows = await db.execute(sql`
            with del as (delete from ${sql.identifier(table)} where ctid in (select ctid from ${sql.identifier(table)} where tenant_id = ${tenantId}::uuid limit ${BATCH}) returning 1)
            select count(*)::int as n from del`) as unknown as { n: number }[]
          const n = rows[0]?.n ?? 0
          total += n
          if (n < BATCH) break
        }
        tables[table] = total
      }
      catch (err) {
        // 23503 foreign_key_violation: ещё держит другая таблица — вернёмся после неё
        if ((err as { code?: string }).code === '23503' || String(err).includes('violates foreign key')) next.push(table)
        else throw err
      }
    }
    if (next.length === pending.length) throw new Error(`tenant.purge: не удаётся удалить ${next.join(', ')} — циклические внешние ключи`)
    pending = next
  }
  if (pending.length) throw new Error(`tenant.purge: остались таблицы ${pending.join(', ')}`)
  await db.delete(tenants).where(eq(tenants.id, tenantId))
  const s3 = await deleteS3Prefix(`t/${tenantId}/`)
  invalidateTenant(tenantId)
  invalidateLimits(tenantId)
  const report: PurgeReport = { tenantId, slug: t.slug, tables: Object.fromEntries(Object.entries(tables).filter(([, n]) => n > 0)), passes, s3, durationMs: Date.now() - started }
  await db.insert(platformAudit).values({
    adminId: actor?.adminId ?? null, adminEmail: actor?.email ?? 'worker', action: 'tenant.purged', subjectTenantId: null,
    entity: 'tenant', entityId: tenantId, before: { slug: t.slug, name: t.name, archivedAt: t.archivedAt }, after: report, requestContext: currentRequestContext(),
  })
  return report
}

/**
 * Обработчик задачи `tenant.purge`: исполняет только если тенант всё ещё archived и срок вышел —
 * отменённый purge (archived_at = null, статус suspended) просто не сработает.
 */
export async function runTenantPurge(tenantId: string): Promise<{ purged: boolean, reason?: string, report?: PurgeReport }> {
  const t = await loadTenant(tenantId)
  if (!t) return { purged: false, reason: 'not_found' }
  if (t.status !== 'archived' || !t.archivedAt) return { purged: false, reason: 'not_archived' }
  if (purgeAtOf(t.archivedAt)!.getTime() > Date.now()) return { purged: false, reason: 'too_early' }
  return { purged: true, report: await purgeTenantData(tenantId) }
}
