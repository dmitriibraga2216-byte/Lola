import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import { currentRequestContext } from '../utils/requestContext'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { sessions, users } from '../db/schema'
import { TWO_FACTOR_PENDING_MINUTES, type TwoFactorStep } from '../../shared/domain/twoFactor'
import { withTenant, type TenantTx } from '../utils/withTenant'
import { sessionByTokenHash } from './authLookup'
import { defaultRoleOf, effectiveRoles } from './activeRole'
import { CANDIDATE_ACCESS_EXPIRED_REDIRECT, CandidateAccessExpiredError, assertCandidateMayEnter } from './candidateAccess'
import type { CallbackResult } from './oauth'
import { logSecurity } from './securityLog'
import { TenantClosedError, tenantById } from './tenantResolve'
import { holdsSeat } from './repo/people'
import { assertSeatsWithinLimit, seatText } from './tenantLimits'

/**
 * Сессии (docs/01-roles.md §1.5): токен — 32 байта, в БД только sha256-хеш,
 * сырой токен живёт в httpOnly cookie. Срок 30 дней с продлением.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const TOUCH_INTERVAL_MS = 60 * 60 * 1000 // продлеваем не чаще раза в час

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Чем подтверждена личность при входе (`sessions.login_method`, docs/33 D-021): по нему решается, можно ли восстановить пароль. */
export type LoginMethod = 'otp' | 'otp_sms' | 'otp_telegram' | 'otp_email' | 'password' | 'password_otp' | 'google' | 'invite' | 'impersonation'
export const OTP_LOGIN_METHODS: readonly LoginMethod[] = ['otp', 'otp_sms', 'otp_telegram', 'otp_email']

/** 403 `login_form_hidden` — политика «Приховати форму входу» (docs/24 §3.4.1, docs/33 D-021): вход только через Google. */
export class LoginFormHiddenError extends Error {
  statusCode = 403
  data = { code: 'login_form_hidden', message: 'Вхід за кодом чи паролем вимкнено — увійдіть через корпоративний обліковий запис Google' }
  constructor() { super('login_form_hidden') }
}

/**
 * «Приховати форму входу» действует только когда есть чем заменить форму — Google настроен на платформе
 * (docs/09 §9.1); иначе политика игнорируется, чтобы администратор не запер всех снаружи.
 */
export async function loginFormHidden(tenantId: string, userId: string): Promise<boolean> {
  const { isConfigured } = await import('./oauth')
  if (!isConfigured('google')) return false
  const { readSettings } = await import('./settings')
  const settings = await withTenant(tenantId, userId, tx => readSettings(tx, tenantId))
  return settings.policies.auth.hideLoginForm === true
}

/** Результат входа: `twoFactor` не null — сессия промежуточная, нужен второй фактор (docs/24 §3.4). */
export interface CreatedSession {
  token: string
  sessionId: string
  expiresAt: Date
  twoFactor: TwoFactorStep | null
}

/**
 * Первый вход активирует приглашённого (жизненный цикл, docs/01-roles.md §1.6) — только
 * полноценный вход. Активация и есть момент, когда сотрудник занимает место по тарифу
 * (docs/25 §10: проверка лимита — «при активации»; docs/v2/35 §13 к. 1): приглашение обещает
 * место, вход его занимает. Поэтому здесь та же проверка мест, что у разблокировки и найма, в
 * транзакции самого входа — иначе приглашённые по одному, пока свободно одно место, заходили бы
 * все. Мест нет — сессия не создаётся, человеку — «зверніться до адміністратора», админам —
 * `limit_exceeded`. Уже активного вход не касается: «вхід не блокується» (§7.4) — про него.
 */
async function markSignedIn(tx: TenantTx, tenantId: string, userId: string): Promise<void> {
  const [u] = await tx.select({ kind: users.kind, status: users.status, isBlocked: users.isBlocked }).from(users).where(eq(users.id, userId))
  if (u && !holdsSeat(u) && holdsSeat({ ...u, status: 'active' })) {
    await assertSeatsWithinLimit(tx, tenantId, 1, { message: c => seatText('loginBlocked', { used: c.used, limit: c.limit ?? '∞' }) })
  }
  await tx.update(users)
    .set({ status: 'active', lastSeenAt: new Date() })
    .where(eq(users.id, userId))
}

export async function createSession(input: {
  tenantId: string
  userId: string
  userAgent?: string | null
  ip?: string | null
  impersonatedBy?: string | null
  loginMethod?: LoginMethod | null
}): Promise<CreatedSession> {
  // docs/25 §8, §14 п. 10: в приостановленный или удаляемый тенант не входит никто — ни по коду, ни по паролю, ни «от имени»
  const tenant = await tenantById(input.tenantId)
  if (tenant && tenant.status !== 'active') throw new TenantClosedError()
  // docs/v2/28 §7.7, §13 к. 7: кандидат вне `active` или с истёкшим `access_until` не входит ни одним
  // путём — все они приходят сюда (services/candidateAccess.ts); 403 `candidate.access_expired`
  await assertCandidateMayEnter(input.tenantId, input.userId)
  // docs/33 D-021: при скрытой форме входа код и пароль не пускают — только Google, приглашение и «от имени»
  if (input.loginMethod && (OTP_LOGIN_METHODS.includes(input.loginMethod) || input.loginMethod === 'password') && await loginFormHidden(input.tenantId, input.userId)) throw new LoginFormHiddenError()
  // Второй фактор (docs/24 §3.4, PR-39): решается здесь, в единственной точке создания сессии,
  // а не в каждом из шести входов — ни один способ входа не может его обойти. «От имени»
  // второй фактор человека не спрашивает: оператор платформы вошёл своим входом, а сессия
  // человека ему не принадлежит (docs/24 §4.5).
  const { secondFactorStep } = await import('./twoFactor')
  const twoFactor = input.loginMethod === 'impersonation' ? null : await secondFactorStep(input.tenantId, input.userId)
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + (twoFactor ? TWO_FACTOR_PENDING_MINUTES * 60_000 : SESSION_TTL_MS))

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
      loginMethod: input.loginMethod ?? null,
      activeRoleId,
      twoFactorPending: twoFactor !== null,
      expiresAt,
    }).returning({ id: sessions.id })

    if (!twoFactor) await markSignedIn(tx, input.tenantId, input.userId)
    return row!.id
  })

  return { token, sessionId, expiresAt, twoFactor }
}

/**
 * Второй фактор пройден: промежуточная сессия становится полной **с новым токеном** —
 * токен промежуточной сессии, даже если его перехватили, полной сессией не станет никогда.
 * Срок — обычный, приглашённый активируется. null — сессии нет, она отозвана, истекла
 * или уже не промежуточная.
 */
export async function completeTwoFactor(auth: AuthContext): Promise<{ token: string, expiresAt: Date } | null> {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  return withTenant(auth.tenantId, auth.userId, async (tx) => {
    const rows = await tx.update(sessions)
      .set({ tokenHash: hashToken(token), twoFactorPending: false, expiresAt, updatedAt: new Date() })
      .where(and(eq(sessions.id, auth.sessionId), eq(sessions.twoFactorPending, true), isNull(sessions.revokedAt), sql`${sessions.expiresAt} > now()`))
      .returning({ id: sessions.id })
    if (!rows.length) return null
    await markSignedIn(tx, auth.tenantId, auth.userId)
    return { token, expiresAt }
  })
}

/** Куда вести человека после колбека провайдера. Редирект делает эндпоинт — сессию ставит сервис. */
export interface SigninOutcome {
  ok: boolean
  userId?: string
  redirectTo: string
}

/**
 * Завершение входа через внешнего провайдера (docs/09 §9.1): e-mail из профиля → ровно один активный
 * пользователь тенанта → сессия, cookie и запись в журнал безопасности.
 *
 * Логика общая для двух колбеков — собственного `/api/v1/auth/<provider>/callback` и общего
 * `/api/v1/integrations/<provider>/callback`: адрес возврата зависит от `OAUTH_SIGNIN_CALLBACK`
 * (см. `redirectUri` в services/oauth.ts), и вернуться может любой из них. Именно раздвоение
 * поведения и ломало вход: колбек интеграций не смотрел `purpose` и показывал окно «Підключено»,
 * не заводя сессию, — поэтому копии этой функции быть не должно (CLAUDE.md п. 6).
 */
export async function completeSignin(event: H3Event, r: CallbackResult): Promise<SigninOutcome> {
  if (!r.ok) return { ok: false, redirectTo: `/login?error=${encodeURIComponent(r.code)}` }
  if (r.purpose !== 'signin') return { ok: false, redirectTo: '/login?error=bad_purpose' }
  const rows = await withTenant(r.tenantId, null, tx => tx.execute(
    sql`select id from users where lower(email) = ${r.accountLabel.toLowerCase()} and status = 'active' limit 2`,
  )) as unknown as { id: string }[]
  // Ровно один: ни «никого» (человека в этом пространстве нет), ни «двое» — угадывать, кем войти, нельзя
  if (rows.length !== 1) return { ok: false, redirectTo: '/login?error=google_no_user' }
  const userId = rows[0]!.id
  // Лениво: utils/authCookies тянет middleware/01.session, а тот — обратно сюда (цикл на уровне модулей)
  const { clientIp, setSessionCookies } = await import('../utils/authCookies')
  const userAgent = getHeader(event, 'user-agent')
  const ip = clientIp(event)
  let created: CreatedSession
  try {
    created = await createSession({ tenantId: r.tenantId, userId, userAgent, ip, loginMethod: 'google' })
  }
  catch (err) {
    // Браузер пришёл редиректом от провайдера — отказ тоже редиректом, текст покажет экран входа
    // на языке человека (docs/v2/28 §7.7), а не JSON ошибки вместо страницы
    if (err instanceof CandidateAccessExpiredError) return { ok: false, userId, redirectTo: CANDIDATE_ACCESS_EXPIRED_REDIRECT }
    throw err
  }
  const { token, twoFactor } = created
  setSessionCookies(event, token)
  // Второй фактор (docs/24 §3.4): вход ещё не завершён — `login.success` пишет подтверждение кода,
  // а человек возвращается на экран входа, к шагу кода
  if (twoFactor) return { ok: true, userId, redirectTo: '/login?step=two-factor' }
  await logSecurity({ tenantId: r.tenantId, userId, event: 'login.success', meta: { method: 'google' }, ip, userAgent })
  return { ok: true, userId, redirectTo: '/' }
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
  /** «Переглянути систему як роль» (docs/24 §3.5, докс/33 D-052): права рахуються по цій ролі — `loadAccess`; мутації заборонені (03.guards). */
  previewRoleId: string | null
  /**
   * Промежуточная сессия двухфакторного входа (docs/24 §3.4, PR-39): первый фактор пройден,
   * второго ещё нет. Открыты только `/auth/two-factor/*` и выход — остальное middleware
   * `01.session` отвечает `401 two_factor_required`.
   */
  twoFactorPending?: boolean
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
    previewRoleId: row.preview_role_id ?? null,
    twoFactorPending: row.two_factor_pending === true,
  }
}

/** Скользящее продление и last_seen_at — не чаще раза в час. */
export async function touchSession(auth: AuthContext): Promise<void> {
  if (auth.impersonatorAdminId) return // сессия «от имени» живёт ровно 60 минут и не продлевается (docs/24 §4.5, §11)
  if (auth.twoFactorPending) return // промежуточная сессия живёт 10 минут и не продлевается (docs/24 §3.4)
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
