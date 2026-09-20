import { desc, eq, sql } from 'drizzle-orm'
import { platformAudit, plans, tenantUsage, tenants } from '../db/schema'
import { db } from '../db/client'
import { withTenant } from '../utils/withTenant'
import { effectiveLimits } from './tenantLimits'
import { enqueueNotification } from './notifications'

/**
 * Потребление тенанта (docs/24 §4.4.1, экран «Статистика» / мокап TenantStats).
 * Собирается раз в сутки задачей `usage.collect` (00:00 по таймзоне тенанта, docs/24 §10), строка на сбор
 * в `tenant_usage`; экран показывает последний сбор и время. Лимит активных считается по `users.status = 'active'`
 * и не заблокированным — блокировка сразу освобождает место (docs/24 §4.4.1 п. 1). Жёсткие лимиты (диск, SMS)
 * проверяются в момент операции, а не здесь.
 */

export interface UsageSnapshot {
  collectedAt: string
  activeUsers: number
  blockedUsers: number
  archivedUsers: number
  storageBytes: number
  smsMonth: number
  coursesCount: number
  assignmentsCount: number
  attemptsMonth: number
}

/** Один сбор: считает всё внутри тенанта и пишет строку. Возвращает снимок. */
export async function collectUsage(tenantId: string): Promise<UsageSnapshot> {
  return withTenant(tenantId, null, async (tx) => {
    const [m] = await tx.execute(sql`
      select
        (select count(*)::int from users where status = 'active' and not is_blocked) as active_users,
        (select count(*)::int from users where is_blocked or status = 'suspended') as blocked_users,
        (select count(*)::int from users where status = 'archived') as archived_users,
        (select coalesce(sum(bytes), 0)::bigint from media_assets where deleted_at is null) as storage_bytes,
        (select count(*)::int from notifications where channel = 'sms' and status = 'sent' and sent_at >= date_trunc('month', now())) as sms_month,
        (select count(*)::int from courses where deleted_at is null) as courses_count,
        (select count(*)::int from assignments where status = 'active') as assignments_count,
        (select count(*)::int from attempts where started_at >= date_trunc('month', now())) as attempts_month
    `) as unknown as Record<string, number | string>[]
    const values = {
      tenantId,
      activeUsers: Number(m!.active_users), blockedUsers: Number(m!.blocked_users), archivedUsers: Number(m!.archived_users),
      storageBytes: Number(m!.storage_bytes), smsMonth: Number(m!.sms_month),
      coursesCount: Number(m!.courses_count), assignmentsCount: Number(m!.assignments_count), attemptsMonth: Number(m!.attempts_month),
    }
    const [row] = await tx.insert(tenantUsage).values(values).returning({ collectedAt: tenantUsage.collectedAt })
    return { collectedAt: row!.collectedAt.toISOString(), ...values, tenantId: undefined } as unknown as UsageSnapshot
  }).then(async (snap) => {
    await checkLimitsAndNotify(tenantId, snap)
    return snap
  })
}

/**
 * `limit_warning` (80% ліміту) і `limit_exceeded` (докс/33 D-054, docs/24 §8, docs/25 §10):
 * адміністраторам тенанта — через звичайні `notifications`, оператору платформи — записом
 * `platform_audit` (він і так дивиться журнал тенанта на панелі, окремої розсилки операторам
 * ще нема). Дедуп на добу: `usage.collect` і так раз на добу, повторний виклик у той самий день
 * (ручний запуск, тести) не спамить.
 */
async function checkLimitsAndNotify(tenantId: string, snap: UsageSnapshot): Promise<void> {
  const limits = await effectiveLimits(tenantId)
  const checks: { resource: 'users' | 'storage' | 'sms', used: number, limit: number | null, label: string }[] = [
    { resource: 'users', used: snap.activeUsers, limit: limits.users, label: 'активних людей' },
    { resource: 'storage', used: snap.storageBytes, limit: limits.storageGb != null ? limits.storageGb * 1024 * 1024 * 1024 : null, label: 'дискового простору' },
    { resource: 'sms', used: snap.smsMonth, limit: limits.smsPerMonth, label: 'SMS за місяць' },
  ]
  const day = snap.collectedAt.slice(0, 10)
  for (const c of checks) {
    if (c.limit == null || c.limit <= 0) continue
    const ratio = c.used / c.limit
    if (ratio < 0.8) continue
    const code = ratio >= 1 ? 'limit_exceeded' : 'limit_warning'
    // Диск — у ГБ для читабельності листа, решта — цілими лічильниками
    const toDisplay = (n: number) => c.resource === 'storage' ? `${(n / (1024 * 1024 * 1024)).toFixed(1)} ГБ` : String(n)
    const payload = { resource: c.label, used: toDisplay(c.used), limit: toDisplay(c.limit), pct: Math.round(ratio * 100) }
    await withTenant(tenantId, null, async (tx) => {
      const admins = await tx.execute(sql`
        select distinct ur.user_id from user_roles ur join roles r on r.id = ur.role_id join users a on a.id = ur.user_id
        where r.code = 'admin' and (ur.valid_until is null or ur.valid_until > now()) and a.status = 'active' and not a.is_blocked
      `) as unknown as { user_id: string }[]
      for (const a of admins) await enqueueNotification(tx, { tenantId, userId: a.user_id, code, payload, dedupKey: `${code}:${c.resource}:${tenantId}:${day}:${a.user_id}` })
    })
    await db.insert(platformAudit).values({ adminId: null, adminEmail: 'system', action: `tenant.${code}`, subjectTenantId: tenantId, entity: 'tenant_limits', entityId: tenantId, after: payload })
  }
}

/** Ежедневный проход по всем активным тенантам (ручной запуск, тесты). */
export async function collectUsageAll(): Promise<number> {
  const rows = await db.execute(sql`select id from tenants where status = 'active'`) as unknown as { id: string }[]
  for (const t of rows) await collectUsage(t.id)
  return rows.length
}

/**
 * Воркер `usage.collect` (раз в час): собирает тенанты, у которых по их таймзоне 00:00 (docs/24 §10)
 * и за сегодняшний локальный день сбора ещё нет. Так «00:00 по таймзоне тенанта» не требует задачи на каждый тенант.
 */
export async function collectUsageDue(): Promise<number> {
  const rows = await db.execute(sql`
    select t.id from tenants t
    where t.status = 'active'
      and extract(hour from (now() at time zone t.timezone)) = 0
      and not exists (
        select 1 from tenant_usage u where u.tenant_id = t.id
          and (u.collected_at at time zone t.timezone)::date = (now() at time zone t.timezone)::date
      )
  `) as unknown as { id: string }[]
  for (const t of rows) await collectUsage(t.id)
  return rows.length
}

export interface UsageView {
  last: UsageSnapshot | null
  plan: { code: string, name: string } | null
  limits: { users: number | null, storageGb: number | null, smsPerMonth: number | null }
  history: { collectedAt: string, activeUsers: number, storageBytes: number }[]
}

/** Для экрана: последний сбор, тариф и лимиты плана, короткая история (30 дней). */
export async function usageView(ctx: { tenantId: string, actorId: string }): Promise<UsageView> {
  const [t] = await db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, ctx.tenantId))
  const [p] = t ? await db.select().from(plans).where(eq(plans.code, t.plan)) : []
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select().from(tenantUsage).orderBy(desc(tenantUsage.collectedAt)).limit(30)
    const toSnap = (r: typeof tenantUsage.$inferSelect): UsageSnapshot => ({
      collectedAt: r.collectedAt.toISOString(), activeUsers: r.activeUsers, blockedUsers: r.blockedUsers, archivedUsers: r.archivedUsers,
      storageBytes: r.storageBytes, smsMonth: r.smsMonth, coursesCount: r.coursesCount, assignmentsCount: r.assignmentsCount, attemptsMonth: r.attemptsMonth,
    })
    return {
      last: rows[0] ? toSnap(rows[0]) : null,
      plan: p ? { code: p.code, name: p.name } : t ? { code: t.plan, name: t.plan } : null,
      limits: { users: p?.maxUsers ?? null, storageGb: p?.maxStorageGb ?? null, smsPerMonth: p?.maxSmsPerMonth ?? null },
      history: rows.map(r => ({ collectedAt: r.collectedAt.toISOString(), activeUsers: r.activeUsers, storageBytes: r.storageBytes })).reverse(),
    }
  })
}
