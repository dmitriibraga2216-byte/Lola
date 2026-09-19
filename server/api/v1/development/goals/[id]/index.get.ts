import { requireScope, can } from '../../../../../services/access'
import { getGoal } from '../../../../../services/development'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.own')
  const g = await getGoal({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!g) return apiError(event, 404, 'not_found', 'Ціль не знайдено')
  if (g.userId !== a.userId && !can(a, 'development.team')) return apiError(event, 403, 'forbidden', 'Немає доступу')
  return apiData(g)
})
