import { reviewRoutingRuleSchema } from '../../../../../shared/schemas/review'
import { requireScope } from '../../../../services/access'
import { reviewActorOf } from '../../../../services/reviewActor'
import { updateRoutingRule } from '../../../../services/reviewRouting'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { ROUTING_ERRORS } from '../../../../utils/reviewErrors'

/** PATCH /review/routing-rules/:id — правка правила целиком, в том числе включение и приоритет (docs/v2/37 §5.3). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.routing.manage')
  const p = reviewRoutingRuleSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте правило: назва, стратегія, перевіряючі', { issues: p.error.issues })
  const r = await updateRoutingRule(reviewActorOf(a), getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    const [status, code, message] = ROUTING_ERRORS[r.code]
    return apiError(event, status, code, message)
  }
  return apiData({ ok: true })
})
