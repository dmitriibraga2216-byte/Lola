import { createHash, randomBytes } from 'node:crypto'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { desc, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../db/schema'
import { platformAdmins, platformSessions, plans, tenants } from '../db/schema'
import { SYSTEM_ROLES } from '../../shared/domain/roles'
import { ensureTenantDefaults } from '../db/tenantDefaults'

/**
 * Панель оператора платформы (docs/03 §3.12, docs/01 §1.5 impersonation).
 * Единственный модуль, работающий ролью platform_admin с BYPASSRLS —
 * отдельное подключение, каждое действие в audit_log/security_log.
 */

let pdb: ReturnType<typeof drizzle<typeof schema>> | undefined
function platformDb() {
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

export async function listTenants() {
  const db = platformDb()
  return db.execute(sql`
    select t.id, t.slug, t.name, t.status, t.plan, t.trial_ends_at, t.created_at,
           (select count(*)::int from users u where u.tenant_id = t.id and u.status = 'active') as active_users,
           (select count(*)::int from users u where u.tenant_id = t.id) as total_users,
           (select count(distinct s.user_id)::int from sessions s where s.tenant_id = t.id and s.created_at >= now() - interval '7 days') as wau,
           (select coalesce(sum(m.bytes), 0)::bigint from media_assets m where m.tenant_id = t.id and m.deleted_at is null) as media_bytes,
           (select count(*)::int from enrollments e where e.tenant_id = t.id and e.status = 'done' and e.completed_at >= now() - interval '30 days') as completed_30d
    from tenants t order by t.created_at desc
  `) as unknown as Promise<Record<string, unknown>[]>
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
      Object.entries(SYSTEM_ROLES).map(([code, r]) => ({ tenantId, code, name: r.name, scopes: [...r.scopes], isSystem: true })),
    ).returning({ id: schema.roles.id, code: schema.roles.code })
    const adminRole = roleRows.find(r => r.code === 'admin')!
    await ensureTenantDefaults(tx, tenantId)

    const [adminUser] = await tx.insert(schema.users).values({ tenantId, phone: input.adminPhone, fullName: input.adminName, status: 'invited' }).returning({ id: schema.users.id })
    await tx.insert(schema.userPlacements).values({ tenantId, userId: adminUser!.id, locationId: loc!.id, positionId: pos!.id, isPrimary: true })
    await tx.update(schema.locations).set({ managerId: adminUser!.id }).where(eq(schema.locations.id, loc!.id))
    await tx.insert(schema.userRoles).values({ tenantId, userId: adminUser!.id, roleId: adminRole.id, scopeType: 'tenant' })

    await tx.insert(schema.auditLog).values({ tenantId, actorId: null, action: 'tenant.create', entity: 'tenant', entityId: tenantId, after: { by: actor.email, plan: planCode } })
    return { ok: true as const, tenantId, adminUserId: adminUser!.id }
  })
}

export async function updateTenant(id: string, input: { status?: string, plan?: string, trialEndsAt?: string | null, name?: string, settings?: Record<string, unknown> }, actor: PlatformAuth) {
  const db = platformDb()
  const [before] = await db.select().from(tenants).where(eq(tenants.id, id))
  if (!before) return null
  const [after] = await db.update(tenants).set({
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.plan !== undefined ? { plan: input.plan } : {}),
    ...(input.trialEndsAt !== undefined ? { trialEndsAt: input.trialEndsAt ? new Date(input.trialEndsAt) : null } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.settings !== undefined ? { settings: { ...(before.settings as object), ...input.settings } } : {}),
    updatedAt: new Date(),
  }).where(eq(tenants.id, id)).returning()
  await db.insert(schema.auditLog).values({ tenantId: id, actorId: null, action: 'tenant.update', entity: 'tenant', entityId: id, before: { status: before.status, plan: before.plan }, after: { ...input, by: actor.email } })
  return after!
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
      (select count(*)::int from users where status = 'active') as users_active,
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
    .from(schema.users).where(eq(schema.users.tenantId, tenantId)).orderBy(desc(schema.users.createdAt)).limit(200)
}

/** Лимиты тарифа (docs/03 §3.12): проверка перед созданием пользователя. */
export async function checkPlanLimit(tenantId: string, what: 'users'): Promise<{ ok: boolean, limit: number | null, current: number }> {
  const db = platformDb()
  const [t] = await db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId))
  const [p] = t ? await db.select().from(plans).where(eq(plans.code, t.plan)) : []
  if (what === 'users') {
    const rows = await db.execute(sql`select count(*)::int as n from users where tenant_id = ${tenantId} and status in ('invited','active')`) as unknown as { n: number }[]
    const n = rows[0]?.n ?? 0
    const limit = p?.maxUsers ?? null
    return { ok: limit === null || n < limit, limit, current: n }
  }
  return { ok: true, limit: null, current: 0 }
}
