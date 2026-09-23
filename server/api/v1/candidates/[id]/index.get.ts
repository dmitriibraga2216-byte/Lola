import { requireAnyScope } from '../../../../services/access'
import { getCandidate, viewerOf } from '../../../../services/candidates'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * GET /candidates/:id — карточка (docs/v2/28 §5.3, §10).
 *
 * Чужой тенант и чужая область — `404`, не `403` (CLAUDE.md п. 15, критерий §13 к. 9):
 * существование записи не подтверждается. Наставник попадает сюда по `review.queue`
 * и получает карточку без контактов, резюме и комментариев (§2, критерий §13 к. 10).
 */
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, ['candidate.view', 'review.queue'])
  const card = await getCandidate(viewerOf(a), getRouterParam(event, 'id')!)
  if (!card) return apiError(event, 404, 'not_found', 'Кандидата не знайдено')
  return apiData(card)
})
