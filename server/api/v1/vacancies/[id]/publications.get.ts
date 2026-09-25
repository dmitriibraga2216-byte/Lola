import { requireScope } from '../../../../services/access'
import { viewerOf } from '../../../../services/vacancies'
import { listPublications } from '../../../../services/vacancyPublications'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** GET /vacancies/:id/publications — журнал публикаций (docs/v2/29 §3.8, §9.3, §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.view')
  const r = await listPublications(viewerOf(a), getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Вакансію не знайдено')
  return apiData({ items: r })
})
