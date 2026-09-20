import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { currentRequestContext } from '../utils/requestContext'
import { eq } from 'drizzle-orm'
import { sessions, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { sessionByTokenHash } from './authLookup'
import { defaultRoleOf, effectiveRoles } from './activeRole'

/**
 * Сессии (docs/01-roles.md §1.5): токен — 32 байта, в БД только sha256-хеш,
 * сырой токен живёт в httpOnly cookie. Срок 30 дней с продлением.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const TOUCH_INTERVAL_MS = 60 * 60 * 1000 // продлеваем не чаще раза в час

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createSession(input: {
  tenantId: string
  userId: string
  userAgent?: string | null
  ip?: string | null
  impersonatedBy?: string | null
}): Promise<{ token: string, sessionId: string, expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  const sessionId = await withTenant(input.tenantId, input.userId, async (tx) => {
    // При входе активная роль — роль по умолчанию (docs/01 §1.9.2, docs/28 «Паритет 4»)
    const activeRoleId = defaultRoleOf(await effectiveRoles(tx, input.userId))?.id ?? null
    const [row] = await tx.insert(sessions).values({
      tenantId: input.tenantId,
      userId: input.userId,
      tokenHash: hashToken(token),
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
      requestContext: currentRequestContext(),
      impersonatedBy: input.impersonatedBy ?? null,
      activeRoleId,
      expiresAt,
    }).returning({ id: sessions.id })

    // Первый вход активирует приглашённого (жизненный цикл, docs/01-roles.md §1.6)
    await tx.update(users)
      .set({ status: 'active', lastSeenAt: new Date() })
      .where(eq(users.id, input.userId))

    return row!.id
  })

  return { token, sessionId, expiresAt }
}

export interface AuthContext {
  sessionId: string
  tenantId: string
  userId: string
  impersonatedBy: string | null
  /** Оператор платформы, вошедший «от имени» (docs/24 §4.5): сессия 60 минут, запреты в middleware 03.guards */
  impersonatorAdminId?: string | null
  /** Активная роль сессии (docs/01 §1.9.2); null — у старых сессий и API-токенов, тогда берётся роль по умолчанию */
  activeRoleId: string | null
}

export async function validateSession(token: string): Promise<AuthContext | null> {
  const row = await sessionByTokenHash(hashToken(token))
  if (!row || row.revoked_at) return null
  if (new Date(row.expires_at) < new Date()) return null

  return {
    sessionId: row.session_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    impersonatedBy: row.impersonated_by,
    impersonatorAdminId: row.impersonator_admin_id ?? null,
    activeRoleId: row.active_role_id,
  }
}

/** Скользящее продление и last_seen_at — не чаще раза в час. */
export async function touchSession(auth: AuthContext): Promise<void> {
  if (auth.impersonatorAdminId) return // сессия «от имени» живёт ровно 60 минут и не продлевается (docs/24 §4.5, §11)
  await withTenant(auth.tenantId, auth.userId, async (tx) => {
    const [row] = await tx.select({ updatedAt: sessions.updatedAt })
      .from(sessions).where(eq(sessions.id, auth.sessionId))
    if (!row || Date.now() - row.updatedAt.getTime() < TOUCH_INTERVAL_MS) return

    const now = new Date()
    await tx.update(sessions)
      .set({ expiresAt: new Date(now.getTime() + SESSION_TTL_MS), updatedAt: now })
      .where(eq(sessions.id, auth.sessionId))
    await tx.update(users).set({ lastSeenAt: now }).where(eq(users.id, auth.userId))
  })
}

export async function revokeSession(auth: AuthContext): Promise<void> {
  await withTenant(auth.tenantId, auth.userId, async (tx) => {
    await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, auth.sessionId))
  })
}

export async function revokeAllSessions(auth: AuthContext): Promise<number> {
  return withTenant(auth.tenantId, auth.userId, async (tx) => {
    const rows = await tx.update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.userId, auth.userId))
      .returning({ id: sessions.id })
    return rows.length
  })
}

/**
 * Одноразовый токен выбора пространства (номер найден в нескольких тенантах):
 * HMAC-подпись, 5 минут, состояние не хранится.
 */
const SELECT_TTL_MS = 5 * 60 * 1000

export function issueSelectToken(phone: string): string {
  const exp = Date.now() + SELECT_TTL_MS
  const payload = `${phone}:${exp}`
  const sig = createHmac('sha256', process.env.SESSION_SECRET || '')
    .update(payload).digest('base64url')
  return Buffer.from(`${payload}:${sig}`).toString('base64url')
}

export function verifySelectToken(token: string): { phone: string } | null {
  try {
    const raw = Buffer.from(token, 'base64url').toString()
    const [phone, expStr, sig] = raw.split(':')
    if (!phone || !expStr || !sig) return null
    if (Number(expStr) < Date.now()) return null
    const expected = createHmac('sha256', process.env.SESSION_SECRET || '')
      .update(`${phone}:${expStr}`).digest('base64url')
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
    return { phone }
  }
  catch {
    return null
  }
}
