import { requireAnyScope } from '../../../../services/access'
import { viewerOf } from '../../../../services/candidates'
import { candidateProgress } from '../../../../services/candidateProgress'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * GET /candidates/:id/progress — вкладка «Проходження» (docs/v2/28 §5.3 п. 2).
 * Открыта тем же, кому открыта карточка (`GET /candidates/:id`); чужой — `404`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, ['candidate.view', 'review.queue'])
  const r = await candidateProgress(viewerOf(a), getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Кандидата не знайдено')
  return apiData(r)
})
