import { auditLog } from '../db/schema'
import { currentEvent, currentRequestContext } from '../utils/requestContext'
import type { TenantTx } from '../utils/withTenant'
import type { Access } from './access'

/**
 * Активная роль и полный набор ролей актора (docs/01 §1.9.2: «аудит пишет и её, и полный набор ролей»).
 * Берутся из Access текущего запроса (requireScope кладёт его в event.context); вне запроса — null.
 */
function actorRoles(actorId: string | null): { actorRoleId: string | null, actorRoles: string[] | null } {
  const access = currentEvent()?.context.access as Access | null | undefined
  if (!access || !actorId || access.userId !== actorId) return { actorRoleId: null, actorRoles: null }
  return { actorRoleId: access.activeRole?.id ?? null, actorRoles: access.roles.length ? access.roles.map(r => r.code) : null }
}

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
    ...actorRoles(input.actorId),
    action: input.action,
    entity: input.entity,
    entityId: input.entityId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    requestContext: currentRequestContext(), // CLAUDE.md п. 14: единый технический контекст
  })
}
