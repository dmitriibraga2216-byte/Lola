import { requireScope } from '../../../../services/access'
import { listCriteria, viewerOf } from '../../../../services/vacancies'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** GET /vacancies/:id/criteria — критерии оценки кандидата (docs/v2/29 §3.3, §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.view')
  const rows = await listCriteria(viewerOf(a), getRouterParam(event, 'id')!)
  if (!rows) return apiError(event, 404, 'not_found', 'Вакансію не знайдено')
  return apiData({ items: rows })
})
