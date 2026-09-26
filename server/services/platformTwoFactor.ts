import { createHash, randomBytes } from 'node:crypto'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { platformAdminRecoveryCodes, platformAdmins, platformSessions } from '../db/schema'
import { TWO_FACTOR_ISSUER, TWO_FACTOR_SETUP_MINUTES } from '../../shared/domain/twoFactor'
import type { TwoFactorVerifyInput } from '../../shared/schemas/twoFactor'
import { decrypt, encrypt } from './crypto'
import { clearRateLimit, hitRateLimitCount, isBlocked, setBlock } from './rateLimit'
import { generateRecoveryCodes, generateSecret, normalizeRecoveryCode, otpauthUri, verifyTotp } from './totp'
import { PLATFORM_SESSION_HOURS, platformDb, type PlatformAuth, type PlatformSession } from './platform'
import { recordPlatformAudit } from './platformTenants'

/**
 * Второй фактор операторов платформы — обязателен (docs/25 §7 п. 8, решение владельца 26.09.2026).
 *
 * Механизм — тот же, что у пользователей тенанта (`twoFactor.ts`, PR-39), без второй реализации:
 * TOTP и резервные коды — `totp.ts`, секрет — только шифротекстом `crypto.ts` (AES-256-GCM), коды —
 * хешами argon2id, принятый шаг не повторяется (`last_used_step`), перебор — окном `rateLimit`.
 * Отличается только хранение: оператор вне тенантов, поэтому колонки `platform_admins` и таблица
 * `platform_admin_recovery_codes` вместо тенантных `user_totp*` под RLS.
 *
 * Вход: пароль даёт промежуточную сессию (`platformLogin`), этот модуль её завершает — кодом
 * (`verify`) или подключением фактора (`startSetup` → `confirmSetup`). Токен сессии при завершении
 * меняется: промежуточный, успевший утечь, полного доступа не даёт.
 */

/** Неверных кодов подряд до блокировки и её длительность — как политика входа тенанта по умолчанию. */
export const OPS_2FA_ATTEMPTS = 5
export const OPS_2FA_BLOCK_MIN = 15

const FAIL_KEY = (adminId: string) => `ops2fa:fail:${adminId}`
const BLOCK_KEY = (adminId: string) => `ops2fa:block:${adminId}`
const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex')

type Admin = typeof platformAdmins.$inferSelect

async function adminOf(adminId: string): Promise<Admin | null> {
  const [a] = await platformDb().select().from(platformAdmins).where(eq(platformAdmins.id, adminId))
  return a ?? null
}

const enrolled = (a: Admin | null): a is Admin & { totpSecretEncrypted: Buffer, totpSecretNonce: Buffer, totpConfirmedAt: Date } =>
  !!a?.totpConfirmedAt && !!a.totpSecretEncrypted && !!a.totpSecretNonce

async function codesLeft(adminId: string): Promise<number> {
  const [r] = await platformDb().select({ n: sql<number>`count(*)::int` }).from(platformAdminRecoveryCodes)
    .where(and(eq(platformAdminRecoveryCodes.adminId, adminId), isNull(platformAdminRecoveryCodes.usedAt)))
  return r?.n ?? 0
}

export type Fail = { ok: false, code: 'invalid', attemptsLeft: number } | { ok: false, code: 'blocked' }

async function registerFailure(adminId: string): Promise<Fail> {
  const n = await hitRateLimitCount(FAIL_KEY(adminId), OPS_2FA_BLOCK_MIN * 60)
  if (n < OPS_2FA_ATTEMPTS) return { ok: false, code: 'invalid', attemptsLeft: OPS_2FA_ATTEMPTS - n }
  await setBlock(BLOCK_KEY(adminId), OPS_2FA_BLOCK_MIN * 60)
  await clearRateLimit(FAIL_KEY(adminId))
  // Подбор нельзя продолжить ни в этой вкладке, ни в соседней
  await platformDb().update(platformSessions).set({ revokedAt: new Date() })
    .where(and(eq(platformSessions.adminId, adminId), eq(platformSessions.twoFactorPending, true), isNull(platformSessions.revokedAt)))
  return { ok: false, code: 'blocked' }
}

/** Сверка кода приложения (сдвигает `last_used_step`) или резервного кода (гасит его). */
async function checkProof(a: Admin, proof: TwoFactorVerifyInput): Promise<'totp' | 'recovery' | null> {
  const db = platformDb()
  if ('code' in proof) {
    if (!enrolled(a)) return null
    const step = verifyTotp(decrypt(a.totpSecretEncrypted, a.totpSecretNonce), proof.code, Date.now(), a.totpLastUsedStep ?? null)
    if (step === null) return null
    // Условие на прежний шаг: два параллельных запроса одним кодом не пройдут оба
    const moved = await db.update(platformAdmins).set({ totpLastUsedStep: step, updatedAt: new Date() })
      .where(and(eq(platformAdmins.id, a.id), a.totpLastUsedStep == null ? isNull(platformAdmins.totpLastUsedStep) : sql`${platformAdmins.totpLastUsedStep} < ${step}`))
      .returning({ id: platformAdmins.id })
    return moved.length ? 'totp' : null
  }
  const given = normalizeRecoveryCode(proof.recoveryCode)
  const codes = await db.select({ id: platformAdminRecoveryCodes.id, hash: platformAdminRecoveryCodes.codeHash })
    .from(platformAdminRecoveryCodes).where(and(eq(platformAdminRecoveryCodes.adminId, a.id), isNull(platformAdminRecoveryCodes.usedAt)))
  for (const c of codes) {
    if (await argonVerify(c.hash, given)) {
      const used = await db.update(platformAdminRecoveryCodes).set({ usedAt: new Date() })
        .where(and(eq(platformAdminRecoveryCodes.id, c.id), isNull(platformAdminRecoveryCodes.usedAt))).returning({ id: platformAdminRecoveryCodes.id })
      return used.length ? 'recovery' : null
    }
  }
  return null
}

/** Промежуточная сессия → полная: новый токен, полный срок. */
async function completeSession(s: PlatformSession): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await platformDb().update(platformSessions).set({
    tokenHash: tokenHash(token), twoFactorPending: false, expiresAt: new Date(Date.now() + PLATFORM_SESSION_HOURS * 3_600_000), updatedAt: new Date(),
  }).where(and(eq(platformSessions.id, s.sessionId), eq(platformSessions.twoFactorPending, true)))
  return token
}

export interface OpsTwoFactorStatus { step: 'verify' | 'enroll' | null, enrolled: boolean, confirmedAt: Date | null, recoveryCodesLeft: number }

export async function status(s: PlatformSession): Promise<OpsTwoFactorStatus> {
  const a = await adminOf(s.adminId)
  const on = enrolled(a)
  return { step: s.twoFactorPending ? (on ? 'verify' : 'enroll') : null, enrolled: on, confirmedAt: on ? a.totpConfirmedAt : null, recoveryCodesLeft: on ? await codesLeft(s.adminId) : 0 }
}

export type VerifyResult = { ok: true, token: string, proof: 'totp' | 'recovery', recoveryCodesLeft: number } | { ok: false, code: 'not_pending' | 'not_enrolled' } | Fail

/** `POST /platform/two-factor/verify`: промежуточная сессия + верный код → полная сессия с новым токеном. */
export async function verify(s: PlatformSession, proof: TwoFactorVerifyInput): Promise<VerifyResult> {
  if (!s.twoFactorPending) return { ok: false, code: 'not_pending' }
  if (await isBlocked(BLOCK_KEY(s.adminId))) return { ok: false, code: 'blocked' }
  const a = await adminOf(s.adminId)
  if (!enrolled(a)) return { ok: false, code: 'not_enrolled' }
  const used = await checkProof(a, proof)
  if (!used) return registerFailure(s.adminId)
  await clearRateLimit(FAIL_KEY(s.adminId))
  const token = await completeSession(s)
  const left = await codesLeft(s.adminId)
  await recordPlatformAudit(s, { action: 'operator.login', entity: 'platform_admin', entityId: s.adminId, after: { twoFactor: used, recoveryCodesLeft: left } })
  return { ok: true, token, proof: used, recoveryCodesLeft: left }
}

export type SetupResult = { ok: true, secret: string, otpauthUrl: string, expiresAt: Date } | { ok: false, code: 'verify_first' | 'code_required' } | Fail

/**
 * `POST /platform/two-factor/setup`: новый секрет ждёт первого кода 15 минут; действующий фактор при
 * этом не снимается. Заменить подключённый — только текущим кодом (чужая вкладка не перепривяжет).
 */
export async function startSetup(s: PlatformSession, input: { code?: string }): Promise<SetupResult> {
  if (await isBlocked(BLOCK_KEY(s.adminId))) return { ok: false, code: 'blocked' }
  const a = await adminOf(s.adminId)
  if (enrolled(a)) {
    if (s.twoFactorPending) return { ok: false, code: 'verify_first' }
    if (!input.code) return { ok: false, code: 'code_required' }
    if (!await checkProof(a, { code: input.code })) return registerFailure(s.adminId)
  }
  const secret = generateSecret()
  const { ciphertext, nonce } = encrypt(secret)
  const now = new Date()
  await platformDb().update(platformAdmins).set({ totpPendingEncrypted: ciphertext, totpPendingNonce: nonce, totpPendingCreatedAt: now, updatedAt: now }).where(eq(platformAdmins.id, s.adminId))
  const account = `${s.email} (консоль)`.replace(/:/g, ' ')
  return { ok: true, secret, otpauthUrl: otpauthUri(secret, `${TWO_FACTOR_ISSUER} Ops`, account), expiresAt: new Date(now.getTime() + TWO_FACTOR_SETUP_MINUTES * 60_000) }
}

export type ConfirmResult = { ok: true, recoveryCodes: string[], token: string | null } | { ok: false, code: 'no_pending' | 'setup_expired' } | Fail

/**
 * `POST /platform/two-factor/confirm`: первый код подтверждает новый секрет, выдаются десять
 * резервных кодов (показать один раз). На экране входа (`enroll`) вход заодно завершается.
 */
export async function confirmSetup(s: PlatformSession, code: string): Promise<ConfirmResult> {
  if (await isBlocked(BLOCK_KEY(s.adminId))) return { ok: false, code: 'blocked' }
  const a = await adminOf(s.adminId)
  if (!a?.totpPendingEncrypted || !a.totpPendingNonce || !a.totpPendingCreatedAt) return { ok: false, code: 'no_pending' }
  if (s.twoFactorPending && enrolled(a)) return { ok: false, code: 'no_pending' }
  if (Date.now() - a.totpPendingCreatedAt.getTime() > TWO_FACTOR_SETUP_MINUTES * 60_000) return { ok: false, code: 'setup_expired' }
  const step = verifyTotp(decrypt(a.totpPendingEncrypted, a.totpPendingNonce), code, Date.now(), null)
  if (step === null) return registerFailure(s.adminId)
  const replaced = enrolled(a)
  const codes = generateRecoveryCodes()
  const hashes = await Promise.all(codes.map(c => argonHash(normalizeRecoveryCode(c))))
  await platformDb().transaction(async (tx) => {
    await tx.update(platformAdmins).set({
      totpSecretEncrypted: a.totpPendingEncrypted, totpSecretNonce: a.totpPendingNonce, totpConfirmedAt: new Date(), totpLastUsedStep: step,
      totpPendingEncrypted: null, totpPendingNonce: null, totpPendingCreatedAt: null, updatedAt: new Date(),
    }).where(eq(platformAdmins.id, a.id))
    await tx.delete(platformAdminRecoveryCodes).where(eq(platformAdminRecoveryCodes.adminId, a.id))
    await tx.insert(platformAdminRecoveryCodes).values(hashes.map(codeHash => ({ adminId: a.id, codeHash })))
  })
  await clearRateLimit(FAIL_KEY(s.adminId))
  await recordPlatformAudit(s, { action: 'operator.two_factor_enable', entity: 'platform_admin', entityId: s.adminId, after: { replaced, duringLogin: s.twoFactorPending } })
  const token = s.twoFactorPending ? await completeSession(s) : null
  if (token) await recordPlatformAudit(s, { action: 'operator.login', entity: 'platform_admin', entityId: s.adminId, after: { twoFactor: 'enrolled' } })
  return { ok: true, recoveryCodes: codes, token }
}

export type ResetResult = { ok: true } | { ok: false, code: 'not_found' | 'self' }

/**
 * Сброс второго фактора другому оператору — только `owner` (право `operators.two_factor_reset`
 * проверяет ручка), с причиной. Фактор, коды и **все сессии** оператора гаснут: следующий вход —
 * с подключением фактора заново. Себе — нельзя: свой фактор меняется своим кодом.
 */
export async function resetForOperator(actor: PlatformAuth, adminId: string, reason: string): Promise<ResetResult> {
  if (adminId === actor.adminId) return { ok: false, code: 'self' }
  const a = await adminOf(adminId).catch(() => null)
  if (!a) return { ok: false, code: 'not_found' }
  await platformDb().transaction(async (tx) => {
    await tx.update(platformAdmins).set({
      totpSecretEncrypted: null, totpSecretNonce: null, totpConfirmedAt: null, totpLastUsedStep: null,
      totpPendingEncrypted: null, totpPendingNonce: null, totpPendingCreatedAt: null, updatedAt: new Date(),
    }).where(eq(platformAdmins.id, adminId))
    await tx.delete(platformAdminRecoveryCodes).where(eq(platformAdminRecoveryCodes.adminId, adminId))
    await tx.update(platformSessions).set({ revokedAt: new Date() }).where(and(eq(platformSessions.adminId, adminId), isNull(platformSessions.revokedAt)))
  })
  await recordPlatformAudit(actor, { action: 'operator.two_factor_reset', entity: 'platform_admin', entityId: adminId, before: { enrolled: enrolled(a) }, after: { email: a.email, reason } })
  return { ok: true }
}
