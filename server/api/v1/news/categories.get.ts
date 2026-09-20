import { requireScope } from '../../../services/access'
import { listNewsCategories } from '../../../services/news'
import { apiData } from '../../../utils/apiResponse'

/** GET /news/categories — справочник категорий новостей (мокап News «Категорія»). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData(await listNewsCategories({ tenantId: a.tenantId, actorId: a.userId }))
})
