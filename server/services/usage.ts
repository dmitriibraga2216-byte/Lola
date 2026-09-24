import { desc, eq, sql } from 'drizzle-orm'
import { plans, tenantUsage, tenants } from '../db/schema'
import { db } from '../db/client'
import { withTenant } from '../utils/withTenant'
import { effectiveLimits } from './tenantLimits'
import type { LimitAxis } from '../../shared/enums'
import { EMPLOYEES_ONLY } from './repo/people'
import type { AxisUsage } from './usageCounters'
import type { NoticeRow } from './limitNotices'

/**
 * Потребление тенанта (docs/24 §4.4.1, экран «Статистика» / мокап TenantStats).
 * Собирается раз в сутки задачей `usage.collect` (00:00 по таймзоне тенанта, docs/24 §10), строка на сбор
 * в `tenant_usage`; экран показывает последний сбор и время. Лимит активных считается по `users.status = 'active'`
 * и не заблокированным — блокировка сразу освобождает место (docs/24 §4.4.1 п. 1). Жёсткие лимиты (диск, SMS)
 * проверяются в момент операции, а не здесь.
 *
 * Считаются только сотрудники (`kind = 'employee'`, docs/v2/35 §7.1, решение docs/v2/44 В-8):
 * кандидат не занимает оплаченного места в штате, у него своя ось `candidates_active`.
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
  /** Восемь колонок среза пакета (docs/v2/35 §3.3), PR-09. */
  planCode: string | null
  candidatesActive: number
  storageByCategory: Record<string, number>
  aiOps: Record<string, number>
  smsOut: number
  telegramOut: number
  integrationsActive: number
  axes: Record<string, number>
}

/**
 * Один сбор: считает всё внутри тенанта и пишет строку. Возвращает снимок.
 *
 * Срез — для графиков и панели оператора (docs/v2/35 §7.5); числа осей берутся из тех же
 * счётчиков реального времени, по которым операция и блокируется, — двух подсчётов у одной
 * оси нет. Моментальные оси перед записью приводятся к факту (`syncLiveAxes`), поэтому
 * `usage_counters.used` сходится с прямым пересчётом (сквозная проверка 15 `42` §5).
 */
export async function collectUsage(tenantId: string): Promise<UsageSnapshot> {
  const { syncLiveAxes, usageByAxis } = await import('./usageCounters')
  // `storage.counter_reconcile` внутри `usage.collect` (docs/v2/34 §7.4 п. 2, §11): полный
  // пересчёт хранилища, суточный срез `storage_usage_daily`, выравнивание оперативного счётчика
  // и дрейф. Идёт первым — оси ниже читают уже выровненный счётчик.
  const { reconcileStorage } = await import('./storage')
  const storage = await reconcileStorage(tenantId)
  await syncLiveAxes(tenantId)
  const axes = await usageByAxis(tenantId)
  const axisUsed = (axis: LimitAxis) => axes.find(a => a.axis === axis)?.used ?? 0
  const [t] = await db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId))
  return withTenant(tenantId, null, async (tx) => {
    const [m] = await tx.execute(sql`
      select
        (select count(*)::int from users where status = 'active' and not is_blocked ${EMPLOYEES_ONLY('')}) as active_users,
        (select count(*)::int from users where (is_blocked or status = 'suspended') ${EMPLOYEES_ONLY('')}) as blocked_users,
        (select count(*)::int from users where status = 'archived' ${EMPLOYEES_ONLY('')}) as archived_users,
        (select count(*)::int from notifications where channel = 'sms' and status = 'sent' and sent_at >= date_trunc('month', now())) as sms_month,
        (select count(*)::int from courses where deleted_at is null) as courses_count,
        (select count(*)::int from assignments where status = 'active') as assignments_count,
        (select count(*)::int from attempts where started_at >= date_trunc('month', now())) as attempts_month
    `) as unknown as Record<string, number | string>[]
    // Разбивка хранилища по девяти ключам — восемь кодов этапов и `other` (решение
    // docs/v2/44 В-10, docs/v2/35 §3.3): из того же пересчёта, что и суточный срез. Биллинг
    // берёт значение пересчёта, а не счётчика (docs/v2/34 §12).
    const storageByCategory: Record<string, number> = storage.byStage
    const values = {
      tenantId,
      activeUsers: Number(m!.active_users), blockedUsers: Number(m!.blocked_users), archivedUsers: Number(m!.archived_users),
      storageBytes: storage.factBytes, smsMonth: Number(m!.sms_month),
      coursesCount: Number(m!.courses_count), assignmentsCount: Number(m!.assignments_count), attemptsMonth: Number(m!.attempts_month),
      planCode: t?.plan ?? null,
      candidatesActive: axisUsed('candidates_active'),
      storageByCategory,
      aiOps: {
        ai_generate_ops: axisUsed('ai_generate_ops'),
        ai_review_ops: axisUsed('ai_review_ops'),
        ai_interview_ops: axisUsed('ai_interview_ops'),
      },
      smsOut: axisUsed('sms_out'),
      telegramOut: axisUsed('telegram_out'),
      integrationsActive: axisUsed('integrations_active'),
      // Нетарифные оси без своей колонки (docs/v2/35 §3.3): пока это только telegram_out
      axes: { telegram_out: axisUsed('telegram_out') },
    }
    const [row] = await tx.insert(tenantUsage).values(values).returning({ collectedAt: tenantUsage.collectedAt })
    return { collectedAt: row!.collectedAt.toISOString(), ...values, tenantId: undefined } as unknown as UsageSnapshot
  }).then(async (snap) => {
    // Предупреждения и деградация — одним механизмом на все одиннадцать осей (docs/v2/35 §7.9,
    // решение В-16). Прежний `checkLimitsAndNotify` на три оси с ключом дедупликации по
    // локализуемой подписи заменён на `limitScan` (docs/28 §28.12).
    const { limitScan } = await import('./limitNotices')
    await limitScan(tenantId).catch(() => null)
    return snap
  })
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
  // Кандидаты — активные тенанты, у которых сейчас час 0 по их поясу. Проверка «сегодня уже
  // собирали» — внутри withTenant: `tenant_usage` под RLS, и с общего соединения app_user строк
  // не видно (из-за этого сбор шёл каждый вызов подряд — docs/33, найдено 22.09).
  const rows = await db.execute(sql`
    select t.id, t.timezone from tenants t
    where t.status = 'active' and extract(hour from (now() at time zone t.timezone)) = 0
  `) as unknown as { id: string, timezone: string }[]
  let n = 0
  for (const t of rows) {
    const done = await withTenant(t.id, null, async (tx) => {
      const r = await tx.execute(sql`
        select 1 from tenant_usage u
        where u.tenant_id = ${t.id}
          and (u.collected_at at time zone ${t.timezone})::date = (now() at time zone ${t.timezone})::date
        limit 1
      `) as unknown as unknown[]
      return r.length > 0
    })
    if (done) continue
    await collectUsage(t.id)
    n++
  }
  return n
}

export interface UsageView {
  last: UsageSnapshot | null
  plan: { code: string, name: string } | null
  limits: { users: number | null, storageGb: number | null, smsPerMonth: number | null }
  /** Эффективный лимит по каждой из одиннадцати осей, в единицах оси (docs/v2/35 §7.1, §7.3). */
  axes: Record<LimitAxis, number | null>
  /** Потребление по осям: факт, лимит, процент, источник и что перестаёт работать (PR-09). */
  consumption: AxisUsage[]
  /** Открытые предупреждения для баннера (docs/v2/35 §5.5, §7.9). */
  notices: NoticeRow[]
  history: { collectedAt: string, activeUsers: number, storageBytes: number }[]
}

/**
 * Для экрана: последний сбор, тариф, **эффективные** лимиты и короткая история (30 дней).
 *
 * Лимиты берутся общей функцией `effectiveLimits` (docs/v2/44 В-5), а не колонками тарифа:
 * до PR-08 экран показывал `plans.max_*` и не знал ни про переопределение оператора, ни про
 * доплаты — то есть число в баннере расходилось с числом, по которому операцию блокировали.
 */
export async function usageView(ctx: { tenantId: string, actorId: string }): Promise<UsageView> {
  const [t] = await db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, ctx.tenantId))
  const [p] = t ? await db.select().from(plans).where(eq(plans.code, t.plan)) : []
  const limits = await effectiveLimits(ctx.tenantId)
  // Потребление и предупреждения — из тех же счётчиков, по которым операция блокируется
  // (docs/v2/35 §7.3: одно число в баннере, в проверке и в счёте).
  const { usageByAxis } = await import('./usageCounters')
  const { activeNotices } = await import('./limitNotices')
  const consumption = await usageByAxis(ctx.tenantId)
  const notices = await activeNotices(ctx.tenantId)
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select().from(tenantUsage).orderBy(desc(tenantUsage.collectedAt)).limit(30)
    const toSnap = (r: typeof tenantUsage.$inferSelect): UsageSnapshot => ({
      collectedAt: r.collectedAt.toISOString(), activeUsers: r.activeUsers, blockedUsers: r.blockedUsers, archivedUsers: r.archivedUsers,
      storageBytes: r.storageBytes, smsMonth: r.smsMonth, coursesCount: r.coursesCount, assignmentsCount: r.assignmentsCount, attemptsMonth: r.attemptsMonth,
      planCode: r.planCode, candidatesActive: r.candidatesActive,
      storageByCategory: r.storageByCategory as Record<string, number>, aiOps: r.aiOps as Record<string, number>,
      smsOut: r.smsOut, telegramOut: r.telegramOut, integrationsActive: r.integrationsActive,
      axes: r.axes as Record<string, number>,
    })
    return {
      last: rows[0] ? toSnap(rows[0]) : null,
      plan: p ? { code: p.code, name: p.name } : t ? { code: t.plan, name: t.plan } : null,
      limits: { users: limits.users, storageGb: limits.storageGb, smsPerMonth: limits.smsPerMonth },
      axes: limits.axes,
      consumption,
      notices,
      history: rows.map(r => ({ collectedAt: r.collectedAt.toISOString(), activeUsers: r.activeUsers, storageBytes: r.storageBytes })).reverse(),
    }
  })
}
