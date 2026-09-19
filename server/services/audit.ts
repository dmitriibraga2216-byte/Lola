import { auditLog } from '../db/schema'
import { currentRequestContext } from '../utils/requestContext'
import type { TenantTx } from '../utils/withTenant'

/**
 * Запись в audit_log (docs/00-overview.md §0.7: каждое изменение — событие).
 * Пишется в той же транзакции, что и само изменение.
 */
export async function recordAudit(tx: TenantTx, input: {
  tenantId: string
  actorId: string | null
  action: string // people.create, people.update, role.assign, import.apply …
  entity: string
  entityId?: string | null
  before?: unknown
  after?: unknown
}): Promise<void> {
  await tx.insert(auditLog).values({
    tenantId: input.tenantId,
    actorId: input.actorId,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    requestContext: currentRequestContext(), // CLAUDE.md п. 14: единый технический контекст
  })
}
