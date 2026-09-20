import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { and, eq, isNull, ne, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { sessions, users } from '../db/schema'
import type { TenantSettings } from '../../shared/schemas/settings'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { logSecurity } from './securityLog'
import { readSettings } from './settings'
import { hitRateLimit, isBlocked, setBlock } from './rateLimit'

/**
 * Вход по e-mail + паролю (docs/01 §1.5 «Резервные способы», docs/16 §14.4–14.5, docs/24 §3.4.1 «Паролі»):
 * альтернатива OTP для методистов и администраторов, включается политикой `passwords.loginEnabled`.
 * Хеш — argon2id, наружу никогда не отдаётся (`getPerson` отбрасывает `password_hash`).
 * Политики из настроек тенанта (Spec 24): минимальная длина, запрет слабых, смена после первого входа,
 * максимальный срок, число попыток и время блокировки. Счётчики попыток — в БД (`rate_limits`), не в памяти.
 */

type PasswordPolicy = TenantSettings['policies']['passwords']
interface Ctx { tenantId: string, actorId: string }

export type PasswordCheck = { ok: true } | { ok: false, code: 'too_short' | 'weak', message: string }

/** Проверка пароля по политике: длина и «Заборонити слабкі паролі» (docs/24 §3.4.1). */
export function checkPasswordPolicy(password: string, policy: PasswordPolicy, person?: { email?: string | null, phone?: string | null }): PasswordCheck {
  if (password.length < policy.minLength) return { ok: false, code: 'too_short', message: `Пароль має бути не коротшим за ${policy.minLength} знаків` }
  if (policy.forbidWeak) {
    const lower = password.toLowerCase()
    const hasLetter = /\p{L}/u.test(password)
    const hasDigit = /\d/.test(password)
    const sameChar = /^(.)\1+$/.test(password)
    const sequence = /^(?:0123456789|1234567890|abcdefghij|qwertyuiop)/i.test(password) || /^(?:\d)+$/.test(password)
    const containsIdentity = [person?.email?.split('@')[0], person?.phone?.replace(/\D/g, '').slice(-9)].some(v => v && v.length >= 4 && lower.includes(v.toLowerCase()))
    if (!hasLetter || !hasDigit || sameChar || sequence || containsIdentity) return { ok: false, code: 'weak', message: 'Пароль надто простий: потрібні літери й цифри, без повторів і без вашого e-mail чи телефону' }
  }
  return { ok: true }
}

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password)
}

export type SetPasswordResult = { ok: true } | { ok: false, code: 'not_found' | 'too_short' | 'weak' | 'wrong_current', message: string }

/**
 * Смена пароля администратором (docs/04 §4.11 `POST /people/:id/password`, скоуп `people.password`):
 * по умолчанию человек меняет его после первого входа, если так велит политика. Событие — `password.reset_by_admin`.
 */
export async function setPasswordByAdmin(ctx: Ctx, userId: string, input: { password: string, mustChange?: boolean }): Promise<SetPasswordResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [u] = await tx.select({ id: users.id, email: users.email, phone: users.phone }).from(users).where(eq(users.id, userId))
    if (!u) return { ok: false as const, code: 'not_found' as const, message: 'Людину не знайдено' }
    const policy = (await readSettings(tx, ctx.tenantId)).policies.passwords
    const check = checkPasswordPolicy(input.password, policy, u)
    if (!check.ok) return check
    const mustChange = input.mustChange ?? policy.changeAfterFirstLogin
    await tx.update(users).set({ passwordHash: await hashPassword(input.password), passwordChangedAt: new Date(), mustChangePassword: mustChange, updatedAt: new Date() }).where(eq(users.id, userId))
    // Чужие сессии по паролю, который больше не действует, закрываются; своя (если админ меняет себе) остаётся
    await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), userId === ctx.actorId ? sql`false` : sql`true`))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'people.password_reset', entity: 'user', entityId: userId, after: { mustChange } })
    await logSecurity({ tenantId: ctx.tenantId, userId, event: 'password.reset_by_admin', meta: { by: ctx.actorId, mustChange } })
    return { ok: true as const }
  })
}

/** Смена собственного пароля (`POST /me/password`): текущий пароль обязателен, если он уже был. Событие — `password.changed`. */
export async function changeOwnPassword(ctx: Ctx, input: { currentPassword?: string, password: string, sessionId?: string }): Promise<SetPasswordResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [u] = await tx.select({ id: users.id, email: users.email, phone: users.phone, passwordHash: users.passwordHash }).from(users).where(eq(users.id, ctx.actorId))
    if (!u) return { ok: false as const, code: 'not_found' as const, message: 'Людину не знайдено' }
    if (u.passwordHash && !(input.currentPassword && await argonVerify(u.passwordHash, input.currentPassword))) return { ok: false as const, code: 'wrong_current' as const, message: 'Поточний пароль невірний' }
    const policy = (await readSettings(tx, ctx.tenantId)).policies.passwords
    const check = checkPasswordPolicy(input.password, policy, u)
    if (!check.ok) return check
    await tx.update(users).set({ passwordHash: await hashPassword(input.password), passwordChangedAt: new Date(), mustChangePassword: false, updatedAt: new Date() }).where(eq(users.id, ctx.actorId))
    // Остальные сессии закрываются — пароль сменён (docs/16 §12 по аналогии со сменой телефона)
    await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, ctx.actorId), isNull(sessions.revokedAt), input.sessionId ? ne(sessions.id, input.sessionId) : sql`true`))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'people.password_change', entity: 'user', entityId: ctx.actorId })
    await logSecurity({ tenantId: ctx.tenantId, userId: ctx.actorId, event: 'password.changed' })
    return { ok: true as const }
  })
}

export interface EmailUser {
  user_id: string
  tenant_id: string
  tenant_slug: string
  tenant_name: string
  full_name: string
  status: string
  is_blocked: boolean
  password_hash: string | null
  must_change_password: boolean
  password_changed_at: string | null
  password_login_enabled: boolean
}

/** Предаутентификационный поиск по e-mail (SECURITY DEFINER, миграция 0038) — единственная «дверь» сквозь RLS для входа по паролю. */
export async function usersByEmail(email: string): Promise<EmailUser[]> {
  const rows = await db.execute(sql`select * from auth_users_by_email(${email})`)
  return rows as unknown as EmailUser[]
}

export type PasswordLoginResult
  = | { ok: true, users: (EmailUser & { mustChangePassword: boolean })[] }
    | { ok: false, code: 'invalid' | 'blocked' | 'disabled', retryAfterSec?: number }

/**
 * Вход по паролю: тенанты, где пароль подошёл и вход по паролю включён. Неудача — `login.failed` (warning)
 * в каждом тенанте e-mail; после `auth.loginAttempts` неудач — блокировка на `session.blockMinutes` и `login.blocked`.
 * Наличие e-mail наружу не раскрывается — ответ одинаковый.
 */
export async function loginWithPassword(email: string, password: string): Promise<PasswordLoginResult> {
  const key = `pwd:fail:${email.toLowerCase()}`
  if (await isBlocked(`pwd:block:${email.toLowerCase()}`)) return { ok: false, code: 'blocked' }
  const candidates = await usersByEmail(email)
  const matched: (EmailUser & { mustChangePassword: boolean })[] = []
  let anyEnabled = false
  for (const c of candidates) {
    if (!c.password_login_enabled) continue
    anyEnabled = true
    if (c.is_blocked || !c.password_hash) continue
    if (!await argonVerify(c.password_hash, password)) continue
    const policy = await withTenant(c.tenant_id, c.user_id, tx => readSettings(tx, c.tenant_id)).then(s => s.policies)
    const expired = !!policy.passwords.maxAgeDays && (!c.password_changed_at || Date.now() - new Date(c.password_changed_at).getTime() > policy.passwords.maxAgeDays * 86_400_000)
    matched.push({ ...c, mustChangePassword: c.must_change_password || expired })
  }
  if (matched.length) {
    await db.execute(sql`delete from rate_limits where key = ${key}`)
    return { ok: true, users: matched }
  }
  if (candidates.length && !anyEnabled) return { ok: false, code: 'disabled' }
  // Попытки считаем по e-mail; лимит — политика первого тенанта с включённым входом (docs/24 §3.4.1 «Аутентифікація»)
  const first = candidates.find(c => c.password_login_enabled)
  const policy = first ? (await withTenant(first.tenant_id, first.user_id, tx => readSettings(tx, first.tenant_id))).policies : null
  const limitEnabled = policy?.auth.limitLoginAttempts ?? true
  const limit = policy?.auth.loginAttempts ?? 5
  const blockSec = (policy?.session.blockMinutes ?? 30) * 60
  // N-я неудача подряд блокирует (как пятый неверный код OTP, docs/01 §1.5): окно счётчика = время блокировки
  const allowed = await hitRateLimit(key, Math.max(1, limit - 1), blockSec)
  const blocked = limitEnabled && !allowed
  if (blocked) await setBlock(`pwd:block:${email.toLowerCase()}`, blockSec)
  for (const c of candidates) {
    if (!c.password_login_enabled) continue
    await logSecurity({ tenantId: c.tenant_id, userId: c.user_id, event: blocked ? 'login.blocked' : 'login.failed', meta: { method: 'password', ...(blocked ? { reason: 'attempts' } : {}) } })
  }
  return blocked ? { ok: false, code: 'blocked', retryAfterSec: blockSec } : { ok: false, code: 'invalid' }
}
