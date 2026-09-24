import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { sessions, tenants, userTotp, userTotpRecoveryCodes, users } from '../db/schema'
import { withTenant, type TenantTx } from '../utils/withTenant'
import { TWO_FACTOR_ADMIN_SCOPE, TWO_FACTOR_ISSUER, TWO_FACTOR_SETUP_MINUTES, type TwoFactorStep } from '../../shared/domain/twoFactor'
import type { TwoFactorVerifyInput } from '../../shared/schemas/twoFactor'
import { decrypt, encrypt } from './crypto'
import { effectiveRoles } from './activeRole'
import { readSettings } from './settings'
import { recordAudit } from './audit'
import { logSecurity } from './securityLog'
import { clearRateLimit, hitRateLimitCount, isBlocked, setBlock } from './rateLimit'
import { generateRecoveryCodes, generateSecret, normalizeRecoveryCode, otpauthUri, verifyTotp } from './totp'
import { EMPLOYEES_ONLY, personById } from './repo/people'
import type { AuthContext } from './session'

/**
 * Двухфакторный вход TOTP (docs/24 §3.4 «Двухфакторность для админов»; docs/v2/39 П-24.1 —
 * «включение на уровне тенанта»; docs/34 Q-10 — «новый экран входа и промежуточная сессия»).
 *
 * Как устроено:
 *  - **где спрашивается** — в единственной точке создания сессии (`createSession`): любой вход
 *    (код, пароль, Google, приглашение, кнопка бота) получает промежуточную сессию, если у человека
 *    подключён фактор или политика тенанта требует его от администраторов. Промежуточная сессия
 *    открывает только `/auth/two-factor/*` и выход (`01.session.ts`);
 *  - **секрет** — только шифротекстом, механизмом токенов интеграций (`crypto.ts`, AES-256-GCM);
 *  - **резервные коды** — только хешами argon2id, показываются один раз;
 *  - **перебор** — неверные коды считаются на человека тем же окном, что вход по коду
 *    (`policies.session.otpAttempts` за `blockMinutes`), после лимита — блокировка входа и отзыв
 *    промежуточных сессий; повтор уже принятого кода не проходит (`last_used_step`);
 *  - **не запереть единственного администратора**: включить политику может только тот, у кого
 *    фактор уже подключён (и резервные коды на руках); потерявший телефон входит резервным кодом;
 *    потерявший и коды — сбрасывается другим администратором (`people.password`) или оператором
 *    платформы с причиной (журналы обеих сторон), после чего подключает фактор заново прямо на
 *    экране входа.
 */

interface Ctx { tenantId: string, actorId: string }

type Factor = typeof userTotp.$inferSelect

const FAIL_KEY = (userId: string) => `2fa:fail:${userId}`
const BLOCK_KEY = (userId: string) => `2fa:block:${userId}`

async function factorOf(tx: TenantTx, userId: string, forUpdate = false): Promise<Factor | null> {
  const q = tx.select().from(userTotp).where(eq(userTotp.userId, userId))
  const [row] = forUpdate ? await q.for('update') : await q
  return row ?? null
}

function isActive(f: Factor | null): f is Factor & { secretEncrypted: Buffer, secretNonce: Buffer, confirmedAt: Date } {
  return !!f?.confirmedAt && !!f.secretEncrypted && !!f.secretNonce
}

const activeSecret = (f: Factor) => decrypt(f.secretEncrypted!, f.secretNonce!)

/** Подпадает ли человек под политику «для админов»: право настроек пространства в любой действующей роли. */
export async function isTwoFactorAdmin(tx: TenantTx, userId: string): Promise<boolean> {
  return (await effectiveRoles(tx, userId)).some(r => r.scopes.includes(TWO_FACTOR_ADMIN_SCOPE))
}

async function policyOn(tx: TenantTx, tenantId: string): Promise<boolean> {
  return (await readSettings(tx, tenantId)).policies.passwords.adminTwoFactor === true
}

/** Нужен ли второй фактор этому человеку сейчас и какой шаг экрана входа: код или подключение. */
export async function secondFactorStep(tenantId: string, userId: string): Promise<TwoFactorStep | null> {
  return withTenant(tenantId, userId, async (tx) => {
    if (isActive(await factorOf(tx, userId))) return 'verify'
    if (await policyOn(tx, tenantId) && await isTwoFactorAdmin(tx, userId)) return 'enroll'
    return null
  })
}

/** Есть ли у человека подключённый фактор — условие включения политики (`settings.updatePolicies`). */
export async function hasActiveFactor(tx: TenantTx, userId: string): Promise<boolean> {
  return isActive(await factorOf(tx, userId))
}

// ── Проверка кода и учёт неудач ─────────────────────────────────────────────────────────

type Proof = TwoFactorVerifyInput

/** Сверка доказательства внутри транзакции: код приложения (сдвигает `last_used_step`) или резервный код (гасит его). */
async function checkProof(tx: TenantTx, f: Factor, userId: string, proof: Proof): Promise<'totp' | 'recovery' | null> {
  if ('code' in proof) {
    const step = verifyTotp(activeSecret(f), proof.code, Date.now(), f.lastUsedStep ?? null)
    if (step === null) return null
    await tx.update(userTotp).set({ lastUsedStep: step, updatedAt: new Date() }).where(eq(userTotp.id, f.id))
    return 'totp'
  }
  const given = normalizeRecoveryCode(proof.recoveryCode)
  const codes = await tx.select({ id: userTotpRecoveryCodes.id, hash: userTotpRecoveryCodes.codeHash })
    .from(userTotpRecoveryCodes)
    .where(and(eq(userTotpRecoveryCodes.userId, userId), isNull(userTotpRecoveryCodes.usedAt)))
  for (const c of codes) {
    if (await argonVerify(c.hash, given)) {
      // Одноразовость держит условие `used_at is null`: второй параллельный вход тем же кодом ничего не обновит
      const used = await tx.update(userTotpRecoveryCodes).set({ usedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(userTotpRecoveryCodes.id, c.id), isNull(userTotpRecoveryCodes.usedAt)))
        .returning({ id: userTotpRecoveryCodes.id })
      return used.length ? 'recovery' : null
    }
  }
  return null
}

export type FailOutcome = { code: 'invalid', attemptsLeft: number } | { code: 'blocked' }

/**
 * Неверный код: `two_factor.failed` в журнал, счётчик на человека. Лимит и длительность
 * блокировки — те же политики, что у входа по коду (docs/24 §3.4: «попыток ввода кода»,
 * «блокировка после превышения»): второй фактор не должен быть слабее первого.
 */
async function registerFailure(tenantId: string, userId: string, what: 'totp' | 'recovery'): Promise<FailOutcome> {
  const policy = await withTenant(tenantId, userId, tx => readSettings(tx, tenantId)).then(s => s.policies.session)
  const windowSec = policy.blockMinutes * 60
  const n = await hitRateLimitCount(FAIL_KEY(userId), windowSec)
  await logSecurity({ tenantId, userId, event: 'two_factor.failed', meta: { proof: what, attempt: n } })
  if (n < policy.otpAttempts) return { code: 'invalid', attemptsLeft: policy.otpAttempts - n }
  await setBlock(BLOCK_KEY(userId), windowSec)
  await clearRateLimit(FAIL_KEY(userId))
  // Промежуточные сессии человека закрываются: подбор нельзя продолжить ни в этой вкладке, ни в соседней
  await withTenant(tenantId, userId, tx => tx.update(sessions).set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), eq(sessions.twoFactorPending, true), isNull(sessions.revokedAt))))
  await logSecurity({ tenantId, userId, event: 'login.blocked', meta: { reason: 'attempts', method: 'two_factor' } })
  return { code: 'blocked' }
}

// ── Вход: второй шаг ────────────────────────────────────────────────────────────────────

export type VerifyResult
  = | { ok: true, token: string, expiresAt: Date, proof: 'totp' | 'recovery', recoveryCodesLeft: number }
    | { ok: false, code: 'not_pending' | 'not_enrolled' | 'blocked' }
    | { ok: false, code: 'invalid', attemptsLeft: number }

/** `POST /auth/two-factor/verify`: промежуточная сессия + верный код → полная сессия с новым токеном. */
export async function verifyAtLogin(auth: AuthContext, proof: Proof): Promise<VerifyResult> {
  if (!auth.twoFactorPending) return { ok: false, code: 'not_pending' }
  if (await isBlocked(BLOCK_KEY(auth.userId))) return { ok: false, code: 'blocked' }
  const r = await withTenant(auth.tenantId, auth.userId, async (tx) => {
    const f = await factorOf(tx, auth.userId, true)
    if (!isActive(f)) return { kind: 'not_enrolled' as const }
    const used = await checkProof(tx, f, auth.userId, proof)
    if (!used) return { kind: 'invalid' as const }
    const [s] = await tx.select({ loginMethod: sessions.loginMethod }).from(sessions).where(eq(sessions.id, auth.sessionId))
    const [left] = await tx.select({ n: sql<number>`count(*)::int` }).from(userTotpRecoveryCodes)
      .where(and(eq(userTotpRecoveryCodes.userId, auth.userId), isNull(userTotpRecoveryCodes.usedAt)))
    return { kind: 'ok' as const, used, loginMethod: s?.loginMethod ?? null, left: left?.n ?? 0 }
  })
  if (r.kind === 'not_enrolled') return { ok: false, code: 'not_enrolled' }
  if (r.kind === 'invalid') {
    const fail = await registerFailure(auth.tenantId, auth.userId, 'code' in proof ? 'totp' : 'recovery')
    return fail.code === 'blocked' ? { ok: false, code: 'blocked' } : { ok: false, code: 'invalid', attemptsLeft: fail.attemptsLeft }
  }
  const { completeTwoFactor } = await import('./session')
  const done = await completeTwoFactor(auth)
  if (!done) return { ok: false, code: 'not_pending' }
  await clearRateLimit(FAIL_KEY(auth.userId))
  if (r.used === 'recovery') await logSecurity({ tenantId: auth.tenantId, userId: auth.userId, event: 'two_factor.recovery_used', meta: { left: r.left } })
  await logSecurity({ tenantId: auth.tenantId, userId: auth.userId, event: 'login.success', meta: { method: r.loginMethod, twoFactor: r.used } })
  return { ok: true, token: done.token, expiresAt: done.expiresAt, proof: r.used, recoveryCodesLeft: r.left }
}

// ── Подключение и замена фактора ────────────────────────────────────────────────────────

export type SetupResult
  = | { ok: true, secret: string, otpauthUrl: string, expiresAt: Date }
    | { ok: false, code: 'verify_first' | 'code_required' | 'blocked' }
    | { ok: false, code: 'invalid', attemptsLeft: number }

/**
 * `POST /auth/two-factor/setup`: новый секрет ждёт первого кода 15 минут. Действующий фактор
 * при этом **не снимается** — замена телефона не оставляет человека без защиты ни на секунду.
 * Заменить уже подключённый фактор можно только текущим кодом (или резервным): иначе чужая
 * открытая вкладка тихо перепривязала бы второй фактор на свой телефон.
 */
export async function startSetup(auth: AuthContext, input: { code?: string }): Promise<SetupResult> {
  if (await isBlocked(BLOCK_KEY(auth.userId))) return { ok: false, code: 'blocked' }
  const r = await withTenant(auth.tenantId, auth.userId, async (tx) => {
    const f = await factorOf(tx, auth.userId, true)
    if (isActive(f)) {
      if (auth.twoFactorPending) return { kind: 'verify_first' as const }
      if (!input.code) return { kind: 'code_required' as const }
      if (!await checkProof(tx, f, auth.userId, { code: input.code })) return { kind: 'invalid' as const }
    }
    const secret = generateSecret()
    const { ciphertext, nonce } = encrypt(secret)
    const now = new Date()
    await tx.insert(userTotp).values({ tenantId: auth.tenantId, userId: auth.userId, pendingSecretEncrypted: ciphertext, pendingNonce: nonce, pendingCreatedAt: now })
      .onConflictDoUpdate({ target: [userTotp.tenantId, userTotp.userId], set: { pendingSecretEncrypted: ciphertext, pendingNonce: nonce, pendingCreatedAt: now, updatedAt: now } })
    const [t] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, auth.tenantId))
    const [p] = await personById(tx, { fullName: users.fullName, email: users.email, phone: users.phone }, auth.userId)
    const account = `${p?.email ?? p?.phone ?? p?.fullName ?? auth.userId} (${t?.name ?? ''})`.replace(/:/g, ' ')
    return { kind: 'ok' as const, secret, url: otpauthUri(secret, TWO_FACTOR_ISSUER, account), expiresAt: new Date(now.getTime() + TWO_FACTOR_SETUP_MINUTES * 60_000) }
  })
  if (r.kind === 'invalid') {
    const fail = await registerFailure(auth.tenantId, auth.userId, 'totp')
    return fail.code === 'blocked' ? { ok: false, code: 'blocked' } : { ok: false, code: 'invalid', attemptsLeft: fail.attemptsLeft }
  }
  if (r.kind !== 'ok') return { ok: false, code: r.kind }
  return { ok: true, secret: r.secret, otpauthUrl: r.url, expiresAt: r.expiresAt }
}

/** Десять новых кодов: старые (и использованные, и нет) гасятся — действуют только последние выданные. */
async function issueRecoveryCodes(tx: TenantTx, tenantId: string, userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes()
  await tx.delete(userTotpRecoveryCodes).where(eq(userTotpRecoveryCodes.userId, userId))
  const hashes = await Promise.all(codes.map(c => argonHash(normalizeRecoveryCode(c))))
  await tx.insert(userTotpRecoveryCodes).values(hashes.map(codeHash => ({ tenantId, userId, codeHash })))
  return codes
}

export type ConfirmResult
  = | { ok: true, recoveryCodes: string[], session: { token: string, expiresAt: Date } | null }
    | { ok: false, code: 'no_pending' | 'setup_expired' | 'blocked' }
    | { ok: false, code: 'invalid', attemptsLeft: number }

/**
 * `POST /auth/two-factor/confirm`: первый код из приложения подтверждает новый секрет. Он
 * становится действующим, выдаются десять резервных кодов (показать один раз). Если это
 * подключение на экране входа (промежуточная сессия `enroll`) — вход заодно завершается.
 */
export async function confirmSetup(auth: AuthContext, code: string): Promise<ConfirmResult> {
  if (await isBlocked(BLOCK_KEY(auth.userId))) return { ok: false, code: 'blocked' }
  const r = await withTenant(auth.tenantId, auth.userId, async (tx) => {
    const f = await factorOf(tx, auth.userId, true)
    if (!f?.pendingSecretEncrypted || !f.pendingNonce || !f.pendingCreatedAt) return { kind: 'no_pending' as const }
    // Промежуточная сессия `verify` подключать не вправе: сначала второй фактор, потом замена
    if (auth.twoFactorPending && isActive(f)) return { kind: 'no_pending' as const }
    if (Date.now() - f.pendingCreatedAt.getTime() > TWO_FACTOR_SETUP_MINUTES * 60_000) return { kind: 'setup_expired' as const }
    const step = verifyTotp(decrypt(f.pendingSecretEncrypted, f.pendingNonce), code, Date.now(), null)
    if (step === null) return { kind: 'invalid' as const }
    const replaced = isActive(f)
    await tx.update(userTotp).set({
      secretEncrypted: f.pendingSecretEncrypted, secretNonce: f.pendingNonce, confirmedAt: new Date(), lastUsedStep: step,
      pendingSecretEncrypted: null, pendingNonce: null, pendingCreatedAt: null, updatedAt: new Date(),
    }).where(eq(userTotp.id, f.id))
    const recoveryCodes = await issueRecoveryCodes(tx, auth.tenantId, auth.userId)
    await recordAudit(tx, { tenantId: auth.tenantId, actorId: auth.userId, action: 'two_factor.enable', entity: 'user', entityId: auth.userId, after: { replaced } })
    return { kind: 'ok' as const, recoveryCodes, replaced }
  })
  if (r.kind === 'invalid') {
    const fail = await registerFailure(auth.tenantId, auth.userId, 'totp')
    return fail.code === 'blocked' ? { ok: false, code: 'blocked' } : { ok: false, code: 'invalid', attemptsLeft: fail.attemptsLeft }
  }
  if (r.kind !== 'ok') return { ok: false, code: r.kind }
  await clearRateLimit(FAIL_KEY(auth.userId))
  await logSecurity({ tenantId: auth.tenantId, userId: auth.userId, event: 'two_factor.enabled', meta: { replaced: r.replaced, duringLogin: auth.twoFactorPending === true } })
  let session: { token: string, expiresAt: Date } | null = null
  if (auth.twoFactorPending) {
    const { completeTwoFactor } = await import('./session')
    session = await completeTwoFactor(auth)
    const [s] = await withTenant(auth.tenantId, auth.userId, tx => tx.select({ loginMethod: sessions.loginMethod }).from(sessions).where(eq(sessions.id, auth.sessionId)))
    if (session) await logSecurity({ tenantId: auth.tenantId, userId: auth.userId, event: 'login.success', meta: { method: s?.loginMethod ?? null, twoFactor: 'enrolled' } })
  }
  return { ok: true, recoveryCodes: r.recoveryCodes, session }
}

// ── Управление своим фактором ───────────────────────────────────────────────────────────

export type ProofResult<T> = ({ ok: true } & T)
  | { ok: false, code: 'not_enrolled' | 'required_by_policy' | 'blocked' }
  | { ok: false, code: 'invalid', attemptsLeft: number }

/** `POST /auth/two-factor/recovery-codes`: перевыпуск — только с кодом, старые коды гаснут. */
export async function regenerateRecoveryCodes(auth: AuthContext, proof: Proof): Promise<ProofResult<{ recoveryCodes: string[] }>> {
  if (await isBlocked(BLOCK_KEY(auth.userId))) return { ok: false, code: 'blocked' }
  const r = await withTenant(auth.tenantId, auth.userId, async (tx) => {
    const f = await factorOf(tx, auth.userId, true)
    if (!isActive(f)) return { kind: 'not_enrolled' as const }
    if (!await checkProof(tx, f, auth.userId, proof)) return { kind: 'invalid' as const }
    const recoveryCodes = await issueRecoveryCodes(tx, auth.tenantId, auth.userId)
    await recordAudit(tx, { tenantId: auth.tenantId, actorId: auth.userId, action: 'two_factor.recovery_codes', entity: 'user', entityId: auth.userId })
    return { kind: 'ok' as const, recoveryCodes }
  })
  if (r.kind === 'invalid') {
    const fail = await registerFailure(auth.tenantId, auth.userId, 'code' in proof ? 'totp' : 'recovery')
    return fail.code === 'blocked' ? { ok: false, code: 'blocked' } : { ok: false, code: 'invalid', attemptsLeft: fail.attemptsLeft }
  }
  if (r.kind !== 'ok') return { ok: false, code: r.kind }
  await clearRateLimit(FAIL_KEY(auth.userId))
  return { ok: true, recoveryCodes: r.recoveryCodes }
}

/**
 * `DELETE /auth/two-factor`: отключить свой фактор — с кодом. Если политика тенанта требует
 * фактор от этого человека, отключение запрещено: иначе требование обходилось бы в два клика.
 * Сменить телефон можно заменой (`setup` + `confirm`), а не отключением.
 */
export async function disableOwn(auth: AuthContext, proof: Proof): Promise<ProofResult<object>> {
  if (await isBlocked(BLOCK_KEY(auth.userId))) return { ok: false, code: 'blocked' }
  const r = await withTenant(auth.tenantId, auth.userId, async (tx) => {
    const f = await factorOf(tx, auth.userId, true)
    if (!isActive(f)) return { kind: 'not_enrolled' as const }
    if (await policyOn(tx, auth.tenantId) && await isTwoFactorAdmin(tx, auth.userId)) return { kind: 'required_by_policy' as const }
    if (!await checkProof(tx, f, auth.userId, proof)) return { kind: 'invalid' as const }
    await tx.delete(userTotpRecoveryCodes).where(eq(userTotpRecoveryCodes.userId, auth.userId))
    await tx.delete(userTotp).where(eq(userTotp.id, f.id))
    await recordAudit(tx, { tenantId: auth.tenantId, actorId: auth.userId, action: 'two_factor.disable', entity: 'user', entityId: auth.userId })
    return { kind: 'ok' as const }
  })
  if (r.kind === 'invalid') {
    const fail = await registerFailure(auth.tenantId, auth.userId, 'code' in proof ? 'totp' : 'recovery')
    return fail.code === 'blocked' ? { ok: false, code: 'blocked' } : { ok: false, code: 'invalid', attemptsLeft: fail.attemptsLeft }
  }
  if (r.kind !== 'ok') return { ok: false, code: r.kind }
  await clearRateLimit(FAIL_KEY(auth.userId))
  await logSecurity({ tenantId: auth.tenantId, userId: auth.userId, event: 'two_factor.disabled', meta: { by: 'self' } })
  return { ok: true }
}

export interface TwoFactorStatus {
  /** Шаг промежуточной сессии; null — сессия полная */
  step: TwoFactorStep | null
  enrolled: boolean
  /** Политика тенанта требует фактор от этого человека */
  required: boolean
  confirmedAt: Date | null
  recoveryCodesLeft: number
  /** Показан новый секрет, первый код ещё не пришёл */
  setupPending: boolean
}

/** `GET /auth/two-factor`: что показать — шаг экрана входа или блок «Мій вхід» в настройках. */
export async function twoFactorStatus(auth: AuthContext): Promise<TwoFactorStatus> {
  return withTenant(auth.tenantId, auth.userId, async (tx) => {
    const f = await factorOf(tx, auth.userId)
    const enrolled = isActive(f)
    const required = await policyOn(tx, auth.tenantId) && await isTwoFactorAdmin(tx, auth.userId)
    const [left] = await tx.select({ n: sql<number>`count(*)::int` }).from(userTotpRecoveryCodes)
      .where(and(eq(userTotpRecoveryCodes.userId, auth.userId), isNull(userTotpRecoveryCodes.usedAt)))
    const setupPending = !!f?.pendingCreatedAt && Date.now() - f.pendingCreatedAt.getTime() <= TWO_FACTOR_SETUP_MINUTES * 60_000
    return {
      step: auth.twoFactorPending ? (enrolled ? 'verify' : 'enroll') : null,
      enrolled,
      required,
      confirmedAt: isActive(f) ? f.confirmedAt : null,
      recoveryCodesLeft: enrolled ? left?.n ?? 0 : 0,
      setupPending,
    }
  })
}

// ── Администратор: обзор и сброс ────────────────────────────────────────────────────────

export interface TwoFactorOverview {
  required: boolean
  admins: { userId: string, fullName: string, enrolled: boolean, confirmedAt: Date | null }[]
}

/**
 * Блок «Двофакторна автентифікація» настроек: включена ли политика и кто из тех, на кого она
 * распространяется, уже подключил фактор. Список — действующие сотрудники с правом настроек
 * пространства в любой действующей роли (тот же критерий, что у `isTwoFactorAdmin`).
 */
export async function twoFactorOverview(ctx: Ctx): Promise<TwoFactorOverview> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const required = await policyOn(tx, ctx.tenantId)
    const rows = await tx.execute(sql`
      select u.id, u.full_name, t.confirmed_at
      from users u
      left join user_totp t on t.user_id = u.id and t.confirmed_at is not null
      where u.status = 'active' and not u.is_blocked ${EMPLOYEES_ONLY('u')}
        and exists (
          select 1 from user_roles ur join roles r on r.id = ur.role_id
          where ur.user_id = u.id and ${TWO_FACTOR_ADMIN_SCOPE} = any(r.scopes)
            and (ur.valid_until is null or ur.valid_until > now())
        )
      order by u.full_name
    `) as unknown as { id: string, full_name: string, confirmed_at: string | null }[]
    return { required, admins: rows.map(r => ({ userId: r.id, fullName: r.full_name, enrolled: !!r.confirmed_at, confirmedAt: r.confirmed_at ? new Date(r.confirmed_at) : null })) }
  })
}

export type ResetResult = { ok: true } | { ok: false, code: 'not_found' | 'not_enrolled' | 'self' }

/** Сброс фактора другого человека внутри транзакции: фактор, коды и **все сессии** человека. */
async function resetTx(tx: TenantTx, userId: string): Promise<'not_found' | 'not_enrolled' | null> {
  const [p] = await personById(tx, { id: users.id }, userId)
  if (!p) return 'not_found'
  const f = await factorOf(tx, userId, true)
  if (!f) return 'not_enrolled'
  await tx.delete(userTotpRecoveryCodes).where(eq(userTotpRecoveryCodes.userId, userId))
  await tx.delete(userTotp).where(eq(userTotp.id, f.id))
  // Сбрасывают фактор, когда телефон потерян или украден: открытые сессии этого человека
  // закрываются — вход заново, уже с новым фактором (или без, если политика не требует)
  await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
  return null
}

/**
 * `DELETE /people/:id/two-factor` (скоуп `people.password`, `sessionOnly`): администратор снимает
 * фактор человеку, потерявшему телефон и резервные коды. Себе — нельзя: свой фактор снимается
 * своим кодом (`disableOwn`), иначе администраторская сессия была бы способом обойти проверку.
 */
export async function resetByAdmin(ctx: Ctx, userId: string): Promise<ResetResult> {
  if (userId === ctx.actorId) return { ok: false, code: 'self' }
  const r = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const err = await resetTx(tx, userId)
    if (err) return err
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'two_factor.reset', entity: 'user', entityId: userId, after: { by: 'admin' } })
    return null
  })
  if (r) return { ok: false, code: r }
  await logSecurity({ tenantId: ctx.tenantId, userId, event: 'two_factor.reset', meta: { by: 'admin', actorId: ctx.actorId } })
  return { ok: true }
}

/**
 * Сброс оператором платформы — последний рубеж «не запереть единственного администратора»:
 * фактор потерян вместе с резервными кодами, а другого администратора в пространстве нет.
 * Причина обязательна (как у входа «от имени», docs/24 §4.5), событие — в журнал безопасности
 * тенанта (critical: клиент видит, что его администратору сбросили второй фактор) и в
 * журнал платформы. Идёт через `withTenant()` тенанта, а не ролью BYPASSRLS.
 */
export async function resetByPlatform(tenantId: string, userId: string, reason: string, operator: { adminId: string, email: string }): Promise<Exclude<ResetResult, { code: 'self' }>> {
  const r = await withTenant(tenantId, null, tx => resetTx(tx, userId))
  if (r) return { ok: false, code: r }
  await logSecurity({ tenantId, userId, event: 'two_factor.reset', meta: { by: 'platform', operator: operator.email, reason } })
  return { ok: true }
}
