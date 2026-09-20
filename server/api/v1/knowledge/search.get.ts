import { searchQuerySchema } from '../../../../shared/schemas/hub'
import { requireScope } from '../../../services/access'
import { search } from '../../../services/knowledge'
import { apiData, apiError } from '../../../utils/apiResponse'

/** GET /knowledge/search?q=&in=all|resources|news|notices — единый поиск по источникам (docs/04 §4.13). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = searchQuerySchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невідоме джерело пошуку')
  return apiData(await search({ tenantId: a.tenantId, actorId: a.userId }, p.data.q, p.data.limit, p.data.in))
})
