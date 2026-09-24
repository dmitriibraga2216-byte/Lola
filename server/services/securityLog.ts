import { eq, sql } from 'drizzle-orm'
import { securityLog, tenants } from '../db/schema'
import type { SecurityEvent, SecuritySeverity } from '../../shared/enums'
import type { SecuritySettings } from '../../shared/schemas/reports'
import { currentRequestContext } from '../utils/requestContext'
import { EMPLOYEES_ONLY } from './repo/people'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'

/**
 * Уровень события по умолчанию (security_severity из docs/02; градация — docs/16 §15, «Рівень» — docs/22 §13.4):
 * critical — вход от имени, выгрузка персональных данных, смена настроек безопасности;
 * warning — неудачный вход, блокировка по попыткам; остальное — info. Вызывающий может передать severity явно.
 */
export function severityOf(event: SecurityEvent): SecuritySeverity {
  // Сброс второго фактора другим человеком (администратором или оператором платформы) — critical:
  // это ровно то, что сделал бы захвативший чужую учётную запись (docs/24 §3.4, PR-39)
  if (event.startsWith('impersonation.') || event === 'export.personal_data' || event === 'settings.security_changed' || event === 'two_factor.reset') return 'critical'
  if (event === 'login.failed' || event === 'login.blocked' || event === 'otp.failed') return 'warning'
  if (event === 'two_factor.failed' || event === 'two_factor.recovery_used' || event === 'two_factor.disabled') return 'warning'
  return 'info'
}

/** Уровни, о которых уходит письмо при включённом «Повідомляти про зміни на E-mail» (docs/22 §13.4). */
export const ALERT_SEVERITIES: SecuritySeverity[] = ['warning', 'critical']

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = { emailAlerts: false }

export async function securitySettings(tx: TenantTx, tenantId: string): Promise<SecuritySettings> {
  const [t] = await tx.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId))
  return { ...DEFAULT_SECURITY_SETTINGS, ...(((t?.settings ?? {}) as { security?: Partial<SecuritySettings> }).security ?? {}) }
}

/** Переключатель журнала безпеки: настройка тенанта, смена — сама событие безопасности (critical) и строка аудита. */
export async function updateSecuritySettings(ctx: { tenantId: string, actorId: string }, patch: Partial<SecuritySettings>): Promise<SecuritySettings> {
  const next = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const before = await securitySettings(tx, ctx.tenantId)
    const next = { ...before, ...patch }
    await tx.execute(sql`update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{security}', ${JSON.stringify(next)}::jsonb) where id = ${ctx.tenantId}::uuid`)
    const { recordAudit } = await import('./audit')
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'settings.security', entity: 'tenant', entityId: ctx.tenantId, before, after: next })
    return next
  })
  await logSecurity({ tenantId: ctx.tenantId, userId: ctx.actorId, event: 'settings.security_changed', meta: { emailAlerts: next.emailAlerts } })
  return next
}

/**
 * Единственный писатель журнала безопасности (docs/06 §6.6; коды — docs/16 §15 Г-16.2, `security_event` в docs/02).
 * Не должен ронять основной поток; `request_context` — из хелпера запроса (CLAUDE.md п. 14).
 */
export async function logSecurity(input: {
  tenantId: string
  userId?: string | null
  event: SecurityEvent
  severity?: SecuritySeverity
  meta?: Record<string, unknown>
  ip?: string | null
  userAgent?: string | null
}): Promise<void> {
  try {
    await withTenant(input.tenantId, input.userId ?? null, async (tx) => {
      const ctx = currentRequestContext()
      const severity = input.severity ?? severityOf(input.event)
      const requestContext = ctx ?? (input.ip || input.userAgent ? { ip: input.ip ?? null, geo: null, user_agent: input.userAgent ?? null, browser: null, os: null, device: null } : null)
      const [row] = await tx.insert(securityLog).values({
        tenantId: input.tenantId,
        userId: input.userId ?? null,
        event: input.event,
        severity,
        meta: input.meta ?? {},
        ip: input.ip ?? ctx?.ip ?? null,
        userAgent: input.userAgent ?? ctx?.user_agent ?? null,
        // CLAUDE.md п. 14: единый контекст запроса; вне запроса (Telegram-вебхук, панель платформы) — то, что передал вызывающий
        requestContext,
      }).returning({ id: securityLog.id, createdAt: securityLog.createdAt })
      if (ALERT_SEVERITIES.includes(severity)) await alertAdmins(tx, input.tenantId, { id: String(row!.id), event: input.event, severity, userId: input.userId ?? null, ip: requestContext?.ip ?? null, createdAt: row!.createdAt })
    })
  }
  catch (err) {
    console.error('security_log write failed', err)
  }
}

/**
 * «Повідомляти про зміни на E-mail» (docs/22 §13.4): при warning и critical — письмо каждому администратору
 * тенанта с почтой через обычную очередь уведомлений (канал email). Ключ дедупликации — строка журнала.
 */
async function alertAdmins(tx: TenantTx, tenantId: string, e: { id: string, event: string, severity: SecuritySeverity, userId: string | null, ip: string | null, createdAt: Date }): Promise<void> {
  const settings = await securitySettings(tx, tenantId)
  if (!settings.emailAlerts) return
  const admins = await tx.execute(sql`
    select distinct u.id from users u
    join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id
    where r.code = 'admin' and u.status = 'active' and not u.is_blocked and u.email is not null ${EMPLOYEES_ONLY()}
      and (ur.valid_until is null or ur.valid_until > now())`) as unknown as { id: string }[]
  if (!admins.length) return
  const [person] = e.userId ? await tx.execute(sql`select full_name from users where id = ${e.userId}::uuid`) as unknown as { full_name: string }[] : []
  const { enqueueNotification } = await import('./notifications')
  const level = e.severity === 'critical' ? 'Критично' : 'Увага'
  for (const a of admins) {
    await enqueueNotification(tx, {
      tenantId, userId: a.id, code: 'security_alert', channel: 'email', urgent: true,
      payload: { level, event: e.event, person: person?.full_name ?? '', when: e.createdAt.toISOString(), ip: e.ip ?? '', url: '/admin/journals?tab=security', securityLogId: e.id },
      dedupKey: `security_alert:${e.id}:${a.id}`,
    })
  }
}
