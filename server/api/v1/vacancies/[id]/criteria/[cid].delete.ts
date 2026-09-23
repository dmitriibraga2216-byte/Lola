import { requireScope } from '../../../../../services/access'
import { deleteCriterion, viewerOf } from '../../../../../services/vacancies'
import { apiError } from '../../../../../utils/apiResponse'

/** DELETE /vacancies/:id/criteria/:cid — удаление критерия (docs/v2/29 §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.criteria.manage')
  const r = await deleteCriterion(viewerOf(a), getRouterParam(event, 'id')!, getRouterParam(event, 'cid')!)
  if (r === 'not_found') return apiError(event, 404, 'not_found', 'Критерій не знайдено')
  setResponseStatus(event, 204)
  return null
})
