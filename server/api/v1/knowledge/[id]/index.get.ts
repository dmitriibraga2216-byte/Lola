import { requireScope } from '../../../../services/access'
import { getArticle } from '../../../../services/knowledge'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const art = await getArticle({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, { countView: true })
  if (!art || (art.status !== 'published' && !(await import('../../../../services/access')).can(a, 'knowledge.manage'))) return apiError(event, 404, 'not_found', 'Статтю не знайдено')
  return apiData(art)
})
