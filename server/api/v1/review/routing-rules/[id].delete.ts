import { requireScope } from '../../../../services/access'
import { reviewActorOf } from '../../../../services/reviewActor'
import { deleteRoutingRule } from '../../../../services/reviewRouting'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { ROUTING_ERRORS } from '../../../../utils/reviewErrors'

/**
 * DELETE /review/routing-rules/:id — удалить правило. Работы, назначенные им, остаются у своих
 * проверяющих (`rqi_assigned_by_rule_id_fk` — `set null`, решение В-13).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.routing.manage')
  const r = await deleteRoutingRule(reviewActorOf(a), getRouterParam(event, 'id')!)
  if (!r.ok) {
    const [status, code, message] = ROUTING_ERRORS[r.code]
    return apiError(event, status, code, message)
  }
  return apiData({ ok: true })
})
