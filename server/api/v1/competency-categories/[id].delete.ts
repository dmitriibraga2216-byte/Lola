import { requireScope } from '../../../services/access'
import { deleteCategory } from '../../../services/developmentExtra'
import { apiData, apiError } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'competency.manage')
  const ok = await deleteCategory({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!ok) return apiError(event, 404, 'not_found', 'Категорію не знайдено')
  return apiData({ ok: true })
})
