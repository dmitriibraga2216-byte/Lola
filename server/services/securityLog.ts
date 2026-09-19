import { securityLog } from '../db/schema'
import type { SecuritySeverity } from '../../shared/enums'
import { currentRequestContext } from '../utils/requestContext'
import { withTenant } from '../utils/withTenant'

/**
 * Уровень события по умолчанию (security_severity из docs/02; градация — docs/16 §15, «Рівень» — docs/22 §13.4):
 * critical — вход от имени, выгрузка персональных данных, смена настроек безопасности;
 * warning — неудачный вход, блокировка по попыткам; остальное — info. Вызывающий может передать severity явно.
 */
export function severityOf(event: string): SecuritySeverity {
  if (event.startsWith('impersonation.') || event === 'export.personal_data' || event === 'settings.security_changed') return 'critical'
  if (event === 'login.failed' || event === 'login.blocked' || event === 'otp.failed') return 'warning'
  return 'info'
}

/** Запись в журнал безопасности (docs/06-infra.md §6.6). Не должна ронять основной поток. */
export async function logSecurity(input: {
  tenantId: string
  userId?: string | null
  event: string
  severity?: SecuritySeverity
  meta?: Record<string, unknown>
  ip?: string | null
  userAgent?: string | null
}): Promise<void> {
  try {
    await withTenant(input.tenantId, input.userId ?? null, async (tx) => {
      const ctx = currentRequestContext()
      await tx.insert(securityLog).values({
        tenantId: input.tenantId,
        userId: input.userId ?? null,
        event: input.event,
        severity: input.severity ?? severityOf(input.event),
        meta: input.meta ?? {},
        ip: input.ip ?? ctx?.ip ?? null,
        userAgent: input.userAgent ?? ctx?.user_agent ?? null,
        // CLAUDE.md п. 14: единый контекст запроса; вне запроса (Telegram-вебхук, панель платформы) — то, что передал вызывающий
        requestContext: ctx ?? (input.ip || input.userAgent ? { ip: input.ip ?? null, geo: null, user_agent: input.userAgent ?? null, browser: null, os: null, device: null } : null),
      })
    })
  }
  catch (err) {
    console.error('security_log write failed', err)
  }
}
