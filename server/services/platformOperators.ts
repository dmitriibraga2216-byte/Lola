import { createHash, randomBytes } from 'node:crypto'
import { hash as argonHash } from '@node-rs/argon2'
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm'
import { platformAdmins, platformSessions } from '../db/schema'
import type { PlatformRole } from '../../shared/enums'
import type { OperatorInviteInput, OperatorPatchInput } from '../../shared/schemas/platformOperators'
import { platformDb, type PlatformAuth } from './platform'
import { recordPlatformAudit } from './platformTenants'
import { opsHostOf } from './opsHost'

/**
 * Операторы платформы (docs/25 §7 п. 7, решение владельца 26.09.2026): список, приглашение, смена
 * роли, деактивация. Право `operators.manage` (только `owner`) проверяет ручка; здесь — правила,
 * которые от права не зависят:
 *  - последнего активного `owner` нельзя понизить или деактивировать — иначе консоль останется без
 *    того, кто может управлять операторами и удалять компании;
 *  - свою роль менять и себя деактивировать нельзя — это делает другой владелец;
 *  - всё — в `platform_audit`.
 * Приглашённый задаёт пароль по одноразовой ссылке (7 дней, в базе — хеш), второй фактор — при
 * первом входе, как все.
 */

export const INVITE_DAYS = 7
const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex')

export interface OperatorRow {
  id: string
  email: string
  fullName: string
  role: PlatformRole
  isActive: boolean
  twoFactor: boolean
  invitePending: boolean
  lastLoginAt: Date | null
  createdAt: Date
}

export async function listOperators(): Promise<OperatorRow[]> {
  const rows = await platformDb().select({
    id: platformAdmins.id, email: platformAdmins.email, fullName: platformAdmins.fullName, role: platformAdmins.role,
    isActive: platformAdmins.isActive, totpConfirmedAt: platformAdmins.totpConfirmedAt, passwordHash: platformAdmins.passwordHash,
    lastLoginAt: platformAdmins.lastLoginAt, createdAt: platformAdmins.createdAt,
  }).from(platformAdmins).orderBy(asc(platformAdmins.fullName))
  return rows.map(r => ({
    id: r.id, email: r.email, fullName: r.fullName, role: r.role, isActive: r.isActive, twoFactor: !!r.totpConfirmedAt,
    invitePending: !r.passwordHash, lastLoginAt: r.lastLoginAt, createdAt: r.createdAt,
  }))
}

/** Адрес консоли для ссылки приглашения: отдельный хост, иначе `APP_URL` (dev). */
export function consoleOrigin(): string {
  const ops = opsHostOf()
  return ops ? `https://${ops}` : (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
}

/**
 * Письмо оператору — платформенным SMTP (`SMTP_URL`, `SMTP_FROM`): оператор вне тенантов, SMTP
 * тенанта тут ни при чём. Не настроено или не ушло — `false`, и ссылку увидит владелец на экране.
 */
async function sendPlatformEmail(to: string, subject: string, text: string): Promise<boolean> {
  const url = process.env.SMTP_URL
  if (!url) return false
  try {
    const nodemailer = await import('nodemailer')
    await nodemailer.createTransport(url).sendMail({ from: process.env.SMTP_FROM || 'lola@localhost', to, subject, text })
    return true
  }
  catch (err) {
    console.error('operator invite email', String(err).slice(0, 200))
    return false
  }
}

export type InviteResult = { ok: true, id: string, emailSent: boolean, inviteUrl: string | null } | { ok: false, code: 'email_taken' }

export async function inviteOperator(actor: PlatformAuth, input: OperatorInviteInput): Promise<InviteResult> {
  const db = platformDb()
  const [taken] = await db.select({ id: platformAdmins.id }).from(platformAdmins).where(eq(platformAdmins.email, input.email))
  if (taken) return { ok: false, code: 'email_taken' }
  const token = randomBytes(32).toString('base64url')
  const [row] = await db.insert(platformAdmins).values({
    email: input.email, fullName: input.fullName, role: input.role, passwordHash: null, invitedBy: actor.adminId,
    inviteTokenHash: tokenHash(token), inviteExpiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
  }).onConflictDoNothing().returning({ id: platformAdmins.id })
  if (!row) return { ok: false, code: 'email_taken' }
  const url = `${consoleOrigin()}/ops/invite?t=${encodeURIComponent(token)}`
  const emailSent = await sendPlatformEmail(input.email, 'Lola — запрошення до консолі оператора',
    `${input.fullName}, вас запросили до консолі оператора платформи Lola.\n\nЗадайте пароль за посиланням (діє ${INVITE_DAYS} днів):\n${url}\n\nПісля пароля консоль попросить налаштувати двофакторну автентифікацію.`)
  await recordPlatformAudit(actor, { action: 'operator.invite', entity: 'platform_admin', entityId: row.id, after: { email: input.email, fullName: input.fullName, role: input.role, emailSent } })
  // Ссылку показываем владельцу, только если письмо не ушло: иначе она лишний раз ходит по экранам
  return { ok: true, id: row.id, emailSent, inviteUrl: emailSent ? null : url }
}

export type PatchResult = { ok: true, operator: OperatorRow } | { ok: false, code: 'not_found' | 'self' | 'last_owner' }

/**
 * Смена роли и активности. Проверка «последний владелец» — под блокировкой строк владельцев в той же
 * транзакции: два владельца, одновременно понижающие друг друга, не оставят консоль без владельца.
 */
export async function patchOperator(actor: PlatformAuth, id: string, input: OperatorPatchInput): Promise<PatchResult> {
  if (id === actor.adminId) return { ok: false, code: 'self' }
  const db = platformDb()
  const r = await db.transaction(async (tx) => {
    const owners = await tx.select({ id: platformAdmins.id }).from(platformAdmins)
      .where(and(eq(platformAdmins.role, 'owner'), eq(platformAdmins.isActive, true))).for('update')
    const [before] = await tx.select().from(platformAdmins).where(eq(platformAdmins.id, id)).for('update')
    if (!before) return { code: 'not_found' as const }
    const losesOwner = before.role === 'owner' && before.isActive
      && ((input.role !== undefined && input.role !== 'owner') || input.isActive === false)
    if (losesOwner && owners.filter(o => o.id !== id).length === 0) return { code: 'last_owner' as const }
    const deactivating = input.isActive === false && before.isActive
    await tx.update(platformAdmins).set({
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive, deactivatedAt: input.isActive ? null : new Date() } : {}),
      updatedAt: new Date(),
    }).where(eq(platformAdmins.id, id))
    // Деактивация и смена роли гасят открытые сессии: права меняются сразу, а не через 12 часов
    if (deactivating || (input.role !== undefined && input.role !== before.role)) {
      await tx.update(platformSessions).set({ revokedAt: new Date() }).where(and(eq(platformSessions.adminId, id), isNull(platformSessions.revokedAt)))
    }
    return { code: null, before }
  })
  if (r.code) return { ok: false, code: r.code }
  const b = r.before!
  if (input.role !== undefined && input.role !== b.role) {
    await recordPlatformAudit(actor, { action: 'operator.role_change', entity: 'platform_admin', entityId: id, before: { role: b.role }, after: { role: input.role, email: b.email } })
  }
  if (input.isActive !== undefined && input.isActive !== b.isActive) {
    await recordPlatformAudit(actor, { action: input.isActive ? 'operator.activate' : 'operator.deactivate', entity: 'platform_admin', entityId: id, before: { isActive: b.isActive }, after: { isActive: input.isActive, email: b.email } })
  }
  const op = (await listOperators()).find(o => o.id === id)!
  return { ok: true, operator: op }
}

/** Приглашение по ссылке: кого приглашают (для экрана), либо null — ссылка неизвестна или истекла. */
export async function inviteInfo(token: string): Promise<{ email: string, fullName: string } | null> {
  const [a] = await platformDb().select({ email: platformAdmins.email, fullName: platformAdmins.fullName }).from(platformAdmins)
    .where(and(eq(platformAdmins.inviteTokenHash, tokenHash(token)), gt(platformAdmins.inviteExpiresAt, sql`now()`), eq(platformAdmins.isActive, true)))
  return a ?? null
}

/** Пароль по ссылке приглашения; ссылка гаснет. Дальше — обычный вход и подключение второго фактора. */
export async function acceptInvite(token: string, password: string): Promise<{ ok: true, email: string } | { ok: false }> {
  const passwordHash = await argonHash(password)
  const [a] = await platformDb().update(platformAdmins).set({ passwordHash, inviteTokenHash: null, inviteExpiresAt: null, updatedAt: new Date() })
    .where(and(eq(platformAdmins.inviteTokenHash, tokenHash(token)), gt(platformAdmins.inviteExpiresAt, sql`now()`), eq(platformAdmins.isActive, true)))
    .returning({ id: platformAdmins.id, email: platformAdmins.email, fullName: platformAdmins.fullName })
  if (!a) return { ok: false }
  await recordPlatformAudit({ adminId: a.id, email: a.email, fullName: a.fullName }, { action: 'operator.invite_accept', entity: 'platform_admin', entityId: a.id })
  return { ok: true, email: a.email }
}
