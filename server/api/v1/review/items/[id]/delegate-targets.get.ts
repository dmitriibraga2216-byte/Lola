import { requireScope } from '../../../../../services/access'
import { reviewActorOf } from '../../../../../services/reviewActor'
import { delegateTargets } from '../../../../../services/reviewDelegation'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/**
 * GET /review/items/:id/delegate-targets — кому можно передать эту работу (docs/v2/37 §6.1:
 * «список отфильтрован заранее: недоступные не показываются вовсе»). Нагрузка каждого — для
 * подсказки «У {ім'я} зараз {N} робіт у черзі, ліміт {M}».
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.delegate')
  const list = await delegateTargets(reviewActorOf(a), getRouterParam(event, 'id')!)
  if (!list) return apiError(event, 404, 'not_found', 'Роботу не знайдено')
  return apiData(list)
})
