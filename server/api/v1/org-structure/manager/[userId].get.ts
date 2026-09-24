import { eq } from 'drizzle-orm'
import { users } from '../../../../db/schema'
import { requireScope } from '../../../../services/access'
import { resolveManager } from '../../../../services/orgManager'
import { withTenant } from '../../../../utils/withTenant'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * GET /org-structure/manager/:userId (docs/v2/32 §10, критерии приёмки 4 и 5) —
 * публичный ответ единственного источника истины о руководителе (П-16.4).
 *
 * Именно здесь `recordConflicts` включён: спросили «кто руководитель» — значит, самое время
 * записать, что человека нет в дереве (`unit_missing`), что руководителя нет вовсе
 * (`no_manager`) или что дерево и поле точки дают разных людей (`manager_mismatch`).
 *
 * Чужой тенант отвечает `404`, а не `403` (правило 15): RLS не отдаст чужую строку `users`,
 * и ответ неотличим от «такого человека нет».
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'org.structure.view')
  const userId = getRouterParam(event, 'userId')!
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return apiError(event, 404, 'not_found', 'Людину не знайдено')
  }
  const r = await withTenant(a.tenantId, a.userId, async (tx) => {
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId))
    if (!u) return null
    return resolveManager(tx, userId, { tenantId: a.tenantId, actorId: a.userId, recordConflicts: true })
  })
  if (!r) return apiError(event, 404, 'not_found', 'Людину не знайдено')
  return apiData({ managerUserId: r.managerUserId, source: r.source, nodeId: r.nodeId, chain: r.chain })
})
