import { createHash, randomBytes } from 'node:crypto'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { desc, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../db/schema'
import { platformAdmins, platformSessions, plans, tenants } from '../db/schema'
import { OWNER_ROLE_CODE, SYSTEM_ROLES } from '../../shared/domain/roles'
import { ensureTenantDefaults } from '../db/tenantDefaults'
import { CANDIDATES_ONLY, EMPLOYEES_ONLY, employeeOnly } from './repo/people'

/**
 * Панель оператора платформы (docs/03 §3.12, docs/01 §1.5 impersonation).
 * Единственный модуль, работающий ролью platform_admin с BYPASSRLS —
 * отдельное подключение, каждое действие в audit_log/security_log.
 */

let pdb: ReturnType<typeof drizzle<typeof schema>> | undefined
/** Подключение ролью platform_admin (BYPASSRLS) — только для платформенных сервисов (docs/25 §7 п. 1). */
export function platformDb() {
  if (!pdb) {
    const url = process.env.PLATFORM_DATABASE_URL
    if (!url) throw new Error('PLATFORM_DATABASE_URL не задан — панель оператора недоступна')
    pdb = drizzle(postgres(url, { max: 5, onnotice: () => {} }), { schema })
  }
  return pdb
}

const hash = (t: string) => createHash('sha256').update(t).digest('hex')

// ── Вход оператора ─────────────────────────────────────────────────────

export async function ensureFirstAdmin(): Promise<void> {
  const email = process.env.PLATFORM_ADMIN_EMAIL
  const password = process.env.PLATFORM_ADMIN_PASSWORD
  if (!email || !password) return
  const db = platformDb()
  const [existing] = await db.select({ id: platformAdmins.id }).from(platformAdmins).where(eq(platformAdmins.email, email))
  if (existing) return
  await db.insert(platformAdmins).values({ email, fullName: 'Оператор Lola', passwordHash: await argonHash(password) })
}

export async function platformLogin(email: string, password: string): Promise<{ token: string } | null> {
  const db = platformDb()
  const [admin] = await db.select().from(platformAdmins).where(eq(platformAdmins.email, email))
  if (!admin || !admin.isActive || !await argonVerify(admin.passwordHash, password)) return null
  const token = randomBytes(32).toString('base64url')
  await db.insert(platformSessions).values({ adminId: admin.id, tokenHash: hash(token), expiresAt: new Date(Date.now() + 12 * 3_600_000) })
  await db.update(platformAdmins).set({ lastLoginAt: new Date() }).where(eq(platformAdmins.id, admin.id))
  return { token }
}

export interface PlatformAuth { adminId: string, email: string, fullName: string }

export async function validatePlatformSession(token: string): Promise<PlatformAuth | null> {
  const db = platformDb()
  const [row] = await db.select({ adminId: platformSessions.adminId, expiresAt: platformSessions.expiresAt, revokedAt: platformSessions.revokedAt, email: platformAdmins.email, fullName: platformAdmins.fullName })
    .from(platformSessions).innerJoin(platformAdmins, eq(platformAdmins.id, platformSessions.adminId))
    .where(eq(platformSessions.tokenHash, hash(token)))
  if (!row || row.revokedAt || row.expiresAt < new Date()) return null
  return { adminId: row.adminId, email: row.email, fullName: row.fullName }
}

// ── Тенанты ────────────────────────────────────────────────────────────

/**
 * Лимиты строки тенанта в панели оператора. Считаются **общей функцией** `effectiveLimits`
 * (docs/v2/44 В-5, план PR-08), а не `coalesce(tl.*, p.max_*)` в этом же запросе: сырой SQL
 * не знал ни про доплаты `tenant_addons` (§7.3), ни про умолчания, и число в панели
 * расходилось с числом проверки при операции и с расчётом счёта.
 */
async function limitColumnsOf(tenantId: string): Promise<Record<string, unknown>> {
  const { effectiveLimits } = await import('./tenantLimits')
  const l = await effectiveLimits(tenantId)
  return {
    users_limit: l.users,
    storage_gb_limit: l.storageGb,
    sms_limit: l.smsPerMonth,
    candidates_limit: l.candidates,
    ai_generate_ops_limit: l.aiGenerateOps,
    ai_review_ops_limit: l.aiReviewOps,
    ai_interview_ops_limit: l.aiInterviewOps,
    export_rows_limit: l.exportRows,
    active_jobs_limit: l.overridden.includes('activeJobs') ? l.activeJobs : null,
    has_overrides: l.overridden.length > 0,
  }
}

export async function listTenants() {
  const db = platformDb()
  const rows = await db.execute(sql`
    select t.id, t.slug, t.name, t.status, t.plan, t.trial_ends_at, t.created_at, t.archived_at, t.custom_domain,
           (select count(*)::int from users u where u.tenant_id = t.id and u.status = 'active' and not u.is_blocked ${EMPLOYEES_ONLY()}) as active_users,
           (select count(*)::int from users u where u.tenant_id = t.id ${EMPLOYEES_ONLY()}) as total_users,
           (select count(distinct s.user_id)::int from sessions s where s.tenant_id = t.id and s.created_at >= now() - interval '7 days') as wau,
           (select coalesce(sum(m.bytes), 0)::bigint from media_assets m where m.tenant_id = t.id and m.deleted_at is null) as media_bytes,
           (select count(*)::int from enrollments e where e.tenant_id = t.id and e.status = 'done' and e.completed_at >= now() - interval '30 days') as completed_30d
    from tenants t
    order by t.created_at desc
  `) as unknown as Record<string, unknown>[]
  return Promise.all(rows.map(async r => ({ ...r, ...await limitColumnsOf(r.id as string) })))
}

/** Карточка одного тенанта (docs/33 D-064: `GET /platform/tenants/:id` из `04` не было — только список и PATCH). */
export async function getTenantCard(id: string): Promise<Record<string, unknown> | null> {
  const db = platformDb()
  const rows = await db.execute(sql`
    select t.id, t.slug, t.name, t.status, t.plan, t.trial_ends_at, t.created_at, t.archived_at,
           (select count(*)::int from users u where u.tenant_id = t.id and u.status = 'active' and not u.is_blocked ${EMPLOYEES_ONLY()}) as active_users,
           (select count(*)::int from users u where u.tenant_id = t.id ${EMPLOYEES_ONLY()}) as total_users,
           (select count(distinct s.user_id)::int from sessions s where s.tenant_id = t.id and s.created_at >= now() - interval '7 days') as wau,
           (select coalesce(sum(m.bytes), 0)::bigint from media_assets m where m.tenant_id = t.id and m.deleted_at is null) as media_bytes,
           (select count(*)::int from enrollments e where e.tenant_id = t.id and e.status = 'done' and e.completed_at >= now() - interval '30 days') as completed_30d
    from tenants t
    where t.id = ${id}::uuid
  `) as unknown as Record<string, unknown>[]
  // Лимиты — из той же общей функции, что и у списка (В-5): карточка и список не расходятся
  return rows[0] ? { ...rows[0], ...await limitColumnsOf(id) } : null
}

export interface CreateTenantInput {
  slug: string
  name: string
  locale?: 'uk' | 'en'
  timezone?: string
  plan?: string
  trialDays?: number
  adminPhone: string
  adminName: string
  locationName?: string
  positionName?: string
}

export type CreateTenantResult = { ok: true, tenantId: string, adminUserId: string } | { ok: false, code: 'slug_taken' | 'plan_unknown' }

/**
 * Создание тенанта (docs/03 §3.12, docs/26 §26.6 seed-tenant): тенант, системные роли
 * по матрице, одна точка, одна позиция, админ. Приёмка: «за 5 минут».
 */
export async function createTenant(input: CreateTenantInput, actor: PlatformAuth): Promise<CreateTenantResult> {
  const db = platformDb()
  const [taken] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, input.slug))
  if (taken) return { ok: false, code: 'slug_taken' }
  const planCode = input.plan ?? 'trial'
  const [plan] = await db.select().from(plans).where(eq(plans.code, planCode))
  if (!plan) return { ok: false, code: 'plan_unknown' }

  return db.transaction(async (tx) => {
    const [tenant] = await tx.insert(tenants).values({
      slug: input.slug,
      name: input.name,
      locale: input.locale ?? 'uk',
      timezone: input.timezone ?? 'Europe/Kyiv',
      plan: planCode,
      trialEndsAt: planCode === 'trial' ? new Date(Date.now() + (input.trialDays ?? 14) * 86_400_000) : null,
    }).returning({ id: tenants.id })
    const tenantId = tenant!.id

    const [root] = await tx.insert(schema.orgUnits).values({ tenantId, name: input.name, path: input.slug.replace(/[^a-z0-9_]/g, '_') }).returning({ id: schema.orgUnits.id })
    const [loc] = await tx.insert(schema.locations).values({ tenantId, orgUnitId: root!.id, name: input.locationName ?? 'Головна', timezone: input.timezone ?? 'Europe/Kyiv' }).returning({ id: schema.locations.id })
    const [pos] = await tx.insert(schema.positions).values({ tenantId, name: input.positionName ?? 'Співробітник' }).returning({ id: schema.positions.id })

    const roleRows = await tx.insert(schema.roles).values(
      Object.entries(SYSTEM_ROLES).map(([code, r]) => ({ tenantId, code, name: r.name, scopes: [...r.scopes], isSystem: true, ...(r.defaultScopeType ? { defaultScopeType: r.defaultScopeType } : {}) })),
    ).returning({ id: schema.roles.id, code: schema.roles.code })
    const adminRole = roleRows.find(r => r.code === 'admin')!
    const ownerRole = roleRows.find(r => r.code === OWNER_ROLE_CODE)!
    await ensureTenantDefaults(tx, tenantId)

    const [adminUser] = await tx.insert(schema.users).values({ tenantId, phone: input.adminPhone, fullName: input.adminName, status: 'invited' }).returning({ id: schema.users.id })
    await tx.insert(schema.userPlacements).values({ tenantId, userId: adminUser!.id, locationId: loc!.id, positionId: pos!.id, isPrimary: true })
    await tx.update(schema.locations).set({ managerId: adminUser!.id }).where(eq(schema.locations.id, loc!.id))
    // Создатель тенанта — и администратор, и владелец (docs/24 §4.3, docs/01 §1.9.4): человек,
    // чей телефон оператор вписал в форму, и есть подписант договора. Две роли, а не одна
    // «большая»: владение и управление системой разведены намеренно, а переключатель ролей
    // даёт ему ходить между ними без выхода (§1.9.2).
    await tx.insert(schema.userRoles).values([
      { tenantId, userId: adminUser!.id, roleId: adminRole.id, scopeType: 'tenant' as const },
      { tenantId, userId: adminUser!.id, roleId: ownerRole.id, scopeType: 'tenant' as const },
    ])

    await tx.insert(schema.auditLog).values({ tenantId, actorId: null, action: 'tenant.create', entity: 'tenant', entityId: tenantId, after: { by: actor.email, plan: planCode } })
    return { ok: true as const, tenantId, adminUserId: adminUser!.id }
  })
}

export type TenantUpdateResult = { ok: true, tenant: typeof tenants.$inferSelect } | { ok: false, code: 'not_found' | 'domain_taken' }

/**
 * Тариф, триал, название, settings, собственный домен (докс/33 D-059). Статус меняется только
 * suspend/resume/purge в `platformTenants` (docs/25 §8). Проверка владения доменом (CNAME,
 * сертификат) — вручную оператором вне кода, см. `27` — код только хранит и резолвит значение.
 */
export async function updateTenant(id: string, input: { plan?: string, trialEndsAt?: string | null, name?: string, settings?: Record<string, unknown>, customDomain?: string | null }, actor: PlatformAuth): Promise<TenantUpdateResult> {
  const db = platformDb()
  const [before] = await db.select().from(tenants).where(eq(tenants.id, id))
  if (!before) return { ok: false, code: 'not_found' }
  if (input.customDomain) {
    const [taken] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.customDomain, input.customDomain))
    if (taken && taken.id !== id) return { ok: false, code: 'domain_taken' }
  }
  const [after] = await db.update(tenants).set({
    ...(input.plan !== undefined ? { plan: input.plan } : {}),
    ...(input.trialEndsAt !== undefined ? { trialEndsAt: input.trialEndsAt ? new Date(input.trialEndsAt) : null } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.settings !== undefined ? { settings: { ...(before.settings as object), ...input.settings } } : {}),
    ...(input.customDomain !== undefined ? { customDomain: input.customDomain } : {}),
    updatedAt: new Date(),
  }).where(eq(tenants.id, id)).returning()
  await db.insert(schema.auditLog).values({ tenantId: id, actorId: null, action: 'tenant.update', entity: 'tenant', entityId: id, before: { status: before.status, plan: before.plan }, after: { ...input, by: actor.email } })
  const { recordPlatformAudit } = await import('./platformTenants')
  await recordPlatformAudit(actor, { action: 'tenant.update', tenantId: id, entity: 'tenant', entityId: id, before: { plan: before.plan, name: before.name, trialEndsAt: before.trialEndsAt, customDomain: before.customDomain }, after: input })
  const { invalidateLimits } = await import('./tenantLimits')
  invalidateLimits(id)
  if (input.customDomain !== undefined) {
    const { invalidateTenant } = await import('./tenantResolve')
    invalidateTenant(id) // сбрасывает и кеш резолва по домену (докс/33 D-059)
  }
  return { ok: true, tenant: after! }
}

export async function listPlans() {
  return platformDb().select().from(plans).orderBy(plans.sort)
}

/** Метрики платформы (docs/03 §3.12): активность, объём медиа, ошибки задач. */
export async function platformMetrics() {
  const db = platformDb()
  const [m] = await db.execute(sql`
    select
      (select count(*)::int from tenants where status = 'active') as tenants_active,
      (select count(*)::int from tenants where plan = 'trial' and trial_ends_at < now() + interval '7 days' and trial_ends_at > now()) as trials_ending,
      (select count(*)::int from users where status = 'active' ${EMPLOYEES_ONLY('')}) as users_active,
      (select count(distinct user_id)::int from sessions where created_at >= current_date) as dau,
      (select count(distinct user_id)::int from sessions where created_at >= current_date - 7) as wau,
      (select coalesce(sum(bytes), 0)::bigint from media_assets where deleted_at is null) as media_bytes,
      (select count(*)::int from notifications where status = 'failed' and created_at >= now() - interval '24 hours') as notifications_failed_24h,
      (select count(*)::int from notifications where status = 'queued') as notifications_queued,
      (select count(*)::int from webhook_deliveries where status = 'failed' and created_at >= now() - interval '24 hours') as webhooks_failed_24h,
      (select count(*)::int from attempts where submitted_at >= current_date) as attempts_today
  `) as unknown as Record<string, unknown>[]
  return m
}

/**
 * Impersonation (docs/24 §4.5, docs/29 Б.13): логика в `services/impersonation` — сессия 60 минут,
 * `impersonation.started` с обеими сторонами, запреты в middleware, уведомление администраторам тенанта.
 */
export async function impersonate(tenantId: string, userId: string, reason: string, actor: PlatformAuth): Promise<{ token: string, expiresAt: Date } | null> {
  const { startImpersonation } = await import('./impersonation')
  const r = await startImpersonation(tenantId, userId, reason, actor)
  return r.ok ? { token: r.token, expiresAt: r.expiresAt } : null
}

export async function tenantUsers(tenantId: string) {
  const db = platformDb()
  return db.select({ id: schema.users.id, fullName: schema.users.fullName, phone: schema.users.phone, status: schema.users.status })
    .from(schema.users).where(employeeOnly(eq(schema.users.tenantId, tenantId))).orderBy(desc(schema.users.createdAt)).limit(200)
}

/**
 * Жёсткая проверка оси в момент операции (docs/25 §10 п. 1, docs/24 §4.4.1, docs/v2/35 §7.5):
 * потребление считается **сейчас**, а не по ночному снимку `tenant_usage`, а лимит берётся
 * общей функцией `checkLimit` (docs/v2/44 В-5) — той же, что у баннера и расчёта счёта.
 *
 * `users` — активные сотрудники (`status = 'active'`, не заблокированные, `kind = 'employee'`):
 * блокировка человека сразу освобождает место. `candidates` — кандидаты в состоянии воронки
 * `active` (`28` §7.1, `35` §7.1): отказ, архивация и найм освобождают место сразу, тенант не
 * платит за архив. Ось включается вместе с рекрутингом (`tenants.candidates_enabled`).
 */
export async function checkPlanLimit(tenantId: string, what: 'users' | 'candidates' = 'users'): Promise<{ ok: boolean, limit: number | null, current: number }> {
  const { checkLimit } = await import('./tenantLimits')
  const db = platformDb()
  const rows = what === 'users'
    ? await db.execute(sql`select count(*)::int as n from users where tenant_id = ${tenantId} and status = 'active' and not is_blocked ${EMPLOYEES_ONLY('')}`) as unknown as { n: number }[]
    : await db.execute(sql`select count(*)::int as n from users where tenant_id = ${tenantId} and candidate_state = 'active' ${CANDIDATES_ONLY('')}`) as unknown as { n: number }[]
  const current = rows[0]?.n ?? 0
  const axis = what === 'users' ? 'users_active' : 'candidates_active'
  const check = await checkLimit(tenantId, axis, current)
  // Счётчик пополняется в той же точке, где ось проверена (docs/v2/45 PR-09): значение
  // `usage_counters.used` обязано совпадать с прямым пересчётом по определению оси
  // (сквозная проверка 15 `42` §5). Второго подсчёта здесь не появляется — в счётчик
  // кладётся ровно то число, по которому только что принято решение.
  const { syncCounter } = await import('./usageCounters')
  await syncCounter(tenantId, axis, current).catch(() => null)
  return { ok: check.ok, limit: check.limit, current }
}
