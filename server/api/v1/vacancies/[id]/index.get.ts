import { requireScope } from '../../../../services/access'
import { getVacancy, viewerOf } from '../../../../services/vacancies'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * GET /vacancies/:id — карточка с критериями и языками (docs/v2/29 §10).
 * Чужой тенант и чужая область дают одинаковый `404` (CLAUDE.md п. 15, критерий §13 к. 14).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.view')
  const row = await getVacancy(viewerOf(a), getRouterParam(event, 'id')!)
  if (!row) return apiError(event, 404, 'not_found', 'Вакансію не знайдено')
  return apiData(row)
})
