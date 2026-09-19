import { securityLog } from '../db/schema'
import { currentRequestContext } from '../utils/requestContext'
import { withTenant } from '../utils/withTenant'

/** Запись в журнал безопасности (docs/06-infra.md §6.6). Не должна ронять основной поток. */
export async function logSecurity(input: {
  tenantId: string
  userId?: string | null
  event: string
  meta?: Record<string, unknown>
  ip?: string | null
  userAgent?: string | null
}): Promise<void> {
  try {
    await withTenant(input.tenantId, input.userId ?? null, async (tx) => {
      await tx.insert(securityLog).values({
        tenantId: input.tenantId,
        userId: input.userId ?? null,
        event: input.event,
        meta: input.meta ?? {},
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        requestContext: currentRequestContext() ?? (input.ip || input.userAgent ? { ip: input.ip ?? null, userAgent: input.userAgent ?? null } : null),
      })
    })
  }
  catch (err) {
    console.error('security_log write failed', err)
  }
}
