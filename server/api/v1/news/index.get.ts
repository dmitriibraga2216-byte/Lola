import { requireScope, can } from '../../../services/access'
import { listNews } from '../../../services/news'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const all = getQuery(event).all === '1' && can(a, 'knowledge.manage')
  return apiData(await listNews({ tenantId: a.tenantId, actorId: a.userId }, { all }))
})
