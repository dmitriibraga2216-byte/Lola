import { createHash, randomBytes } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { auditLog, sessions, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'
import { IMPERSONATION_MINUTES } from '../../shared/schemas/settings'
import { defaultRoleOf, effectiveRoles } from './activeRole'
import { logSecurity } from './securityLog'
import { enqueueNotification } from './notifications'
import type { AuthContext } from './session'

/**
 * Вход «от имени» (docs/24 §4.5, §12.1; docs/29 Б.13; docs/01 §1.5).
 * Оператор платформы открывает сессию человека: причина 10–500 знаков обязательна, сессия живёт 60 минут
 * и не продлевается, в интерфейсе — постоянная коралловая плашка, администратору тенанта уходит уведомление.
 * События `impersonation.started` / `impersonation.ended` (docs/16 §15) пишутся в security_log тенанта
 * с обеими сторонами: оператор (id, e-mail) и человек (id, имя, роли). Запрещённые в этом режиме действия —
 * `FORBIDDEN_ROUTES`, проверяются middleware `03.guards` → 403 `impersonation_forbidden`.
 */

export interface Impersonator { adminId: string, email: string, fullName: string }

/** docs/29 Б.13: роли, выгрузки, уведомления, GDPR-удаление, секреты интеграций. */
export const FORBIDDEN_ROUTES: { method?: string, pattern: RegExp, what: string }[] = [
  { pattern: /^\/api\/v1\/people\/[^/]+\/roles(\/|$)/, what: 'roles' }, // POST/DELETE выдачи ролей
  { pattern: /^\/api\/v1\/settings\/roles(\/|$)/, what: 'roles' },
  { pattern: /^\/api\/v1\/settings\/position-role-map(\/|$)/, what: 'roles' },
  { pattern: /^\/api\/v1\/me\/role\/switch$/, what: 'roles' },
  { pattern: /^\/api\/v1\/exports(\/|$)/, what: 'exports' },
  { pattern: /^\/api\/v1\/people\/export$/, what: 'exports' },
  { pattern: /^\/api\/v1\/reports\/[^/]+\/export$/, what: 'exports' },
  { pattern: /^\/api\/v1\/reports\/builder\/[^/]+\/xlsx$/, what: 'exports' },
  { pattern: /^\/api\/v1\/settings\/translations\/export$/, what: 'exports' },
  { method: 'POST', pattern: /^\/api\/v1\/notifications(\/|$)/, what: 'notifications' },
  { method: 'POST', pattern: /^\/api\/v1\/notices\/[^/]+\/remind$/, what: 'notifications' },
  { method: 'POST', pattern: /^\/api\/v1\/tasks\/[^/]+\/remind$/, what: 'notifications' },
  { method: 'POST', pattern: /^\/api\/v1\/people\/[^/]+\/invite$/, what: 'notifications' },
  { pattern: /^\/api\/v1\/people\/gdpr-erase$/, what: 'gdpr' },
  { pattern: /^\/api\/v1\/settings\/integrations(\/|$)/, what: 'secrets' },
  { pattern: /^\/api\/v1\/settings\/api-tokens(\/|$)/, what: 'secrets' },
  { pattern: /^\/api\/v1\/settings\/webhooks(\/|$)/, what: 'secrets' },
  // Второй фактор человека (docs/24 §3.4, PR-39): оператор «от имени» не подключает, не меняет,
  // не снимает чужой фактор и не сбрасывает его другим — только своим входом в панель оператора
  // (`POST /platform/tenants/:id/users/:userId/two-factor-reset`, с причиной и журналом)
  { pattern: /^\/api\/v1\/auth\/two-factor(\/|$)/, what: 'secrets' },
  { pattern: /^\/api\/v1\/people\/[^/]+\/two-factor$/, what: 'secrets' },
]

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Что запрещено в режиме «от имени» для этого запроса, или null. Чтение разрешено везде, кроме выгрузок. */
export function forbiddenFor(method: string, path: string): string | null {
  const clean = path.split('?')[0]!
  for (const r of FORBIDDEN_ROUTES) {
    if (!r.pattern.test(clean)) continue
    if (r.method && r.method !== method) continue
    if (!r.method && SAFE.has(method) && r.what !== 'exports') continue
    return r.what
  }
  return null
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex')

export type StartResult = { ok: true, token: string, sessionId: string, expiresAt: Date } | { ok: false, code: 'not_found' | 'inactive' }

/** Старт: сессия на 60 минут, помечена оператором и причиной; журналы обеих сторон; уведомление администраторам тенанта. */
export async function startImpersonation(tenantId: string, userId: string, reason: string, actor: Impersonator): Promise<StartResult> {
  return withTenant(tenantId, userId, async (tx): Promise<StartResult> => {
    const [u] = await tx.select({ id: users.id, status: users.status, fullName: users.fullName, isBlocked: users.isBlocked }).from(users).where(eq(users.id, userId))
    if (!u) return { ok: false, code: 'not_found' }
    if (u.status !== 'active' || u.isBlocked) return { ok: false, code: 'inactive' }

    const list = await effectiveRoles(tx, userId)
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + IMPERSONATION_MINUTES * 60_000)
    const [row] = await tx.insert(sessions).values({
      tenantId, userId, tokenHash: hashToken(token), userAgent: `platform:${actor.email}`, ip: null,
      requestContext: currentRequestContext(), impersonatedBy: null, impersonatorAdminId: actor.adminId, impersonationReason: reason, loginMethod: 'impersonation',
      activeRoleId: defaultRoleOf(list)?.id ?? null, expiresAt,
    }).returning({ id: sessions.id })
    const sessionId = row!.id

    const meta = {
      operator: { id: actor.adminId, email: actor.email, name: actor.fullName },
      subject: { id: userId, name: u.fullName, roles: list.map(r => r.code) },
      reason, sessionId, expiresAt: expiresAt.toISOString(),
    }
    await tx.insert(auditLog).values({ tenantId, actorId: null, action: 'user.impersonate', entity: 'user', entityId: userId, after: meta, requestContext: currentRequestContext() })
    // docs/24 §8: impersonation_started администратору тенанта — обязательно
    const admins = await tx.execute(sql`
      select distinct ur.user_id from user_roles ur join roles r on r.id = ur.role_id join users a on a.id = ur.user_id
      where r.code = 'admin' and (ur.valid_until is null or ur.valid_until > now()) and a.status = 'active' and not a.is_blocked
    `) as unknown as { user_id: string }[]
    for (const a of admins) {
      await enqueueNotification(tx, { tenantId, userId: a.user_id, code: 'impersonation_started', payload: { operator: actor.email, subject: u.fullName, reason }, urgent: true, dedupKey: `impersonation:${sessionId}:${a.user_id}` })
    }
    return { ok: true, token, sessionId, expiresAt }
  }).then(async (r) => {
    if (r.ok) await logSecurity({ tenantId, userId, event: 'impersonation.started', meta: { operator: { id: actor.adminId, email: actor.email }, subject: { id: userId }, reason, sessionId: r.sessionId, expiresAt: r.expiresAt.toISOString() } })
    return r
  })
}

/** Стоп — по кнопке «Вихід» на плашке или обычному выходу: сессия отзывается, `impersonation.ended`. */
export async function stopImpersonation(auth: AuthContext): Promise<boolean> {
  if (!auth.impersonatorAdminId) return false
  const info = await withTenant(auth.tenantId, auth.userId, async (tx) => {
    const [s] = await tx.select({ id: sessions.id, adminId: sessions.impersonatorAdminId, reason: sessions.impersonationReason, createdAt: sessions.createdAt, revokedAt: sessions.revokedAt }).from(sessions).where(eq(sessions.id, auth.sessionId))
    if (!s || s.revokedAt) return null
    await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, auth.sessionId))
    return s
  })
  if (!info) return false
  await logSecurity({ tenantId: auth.tenantId, userId: auth.userId, event: 'impersonation.ended', meta: { operator: { id: info.adminId }, subject: { id: auth.userId }, sessionId: info.id, reason: info.reason, durationMin: Math.round((Date.now() - info.createdAt.getTime()) / 60_000) } })
  return true
}

/** Для плашки: кто вошёл и до когда. */
export async function impersonationInfo(auth: AuthContext): Promise<{ operator: string | null, reason: string | null, expiresAt: string } | null> {
  if (!auth.impersonatorAdminId) return null
  return withTenant(auth.tenantId, auth.userId, async (tx) => {
    const [s] = await tx.execute(sql`
      select s.expires_at, s.impersonation_reason as reason, a.email
      from sessions s left join platform_admins a on a.id = s.impersonator_admin_id
      where s.id = ${auth.sessionId}::uuid
    `) as unknown as { expires_at: string, reason: string | null, email: string | null }[]
    return s ? { operator: s.email, reason: s.reason, expiresAt: new Date(s.expires_at).toISOString() } : null
  })
}
