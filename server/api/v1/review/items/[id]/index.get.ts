import { requireScope } from '../../../../../services/access'
import { reviewActorOf } from '../../../../../services/reviewActor'
import { getReviewItem } from '../../../../../services/reviewCard'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/**
 * GET /review/items/:id — карточка проверки (docs/v2/37 §5.2, §10).
 *
 * Сквозная проверка 20 (`docs/v2/42` §5): в ответе нет `phone`, `email`, `resume_asset_id`
 * ни для кого — в том числе для делегата по цепочке из двух передач. Не видящему работу ни в
 * одном табе и автору самой работы — `404`: существование чужой работы не подтверждается.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.queue')
  const card = await getReviewItem(reviewActorOf(a), getRouterParam(event, 'id')!)
  if (!card) return apiError(event, 404, 'not_found', 'Роботу не знайдено')
  return apiData(card)
})
