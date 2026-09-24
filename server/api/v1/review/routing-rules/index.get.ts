import { requireScope } from '../../../../services/access'
import { reviewActorOf } from '../../../../services/reviewActor'
import { listRoutingRules } from '../../../../services/reviewRouting'
import { apiData } from '../../../../utils/apiResponse'

/** GET /review/routing-rules — правила распределения, включая выключенные (docs/v2/37 §5.3, §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.routing.manage')
  return apiData(await listRoutingRules(reviewActorOf(a)))
})
