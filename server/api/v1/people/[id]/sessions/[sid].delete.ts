import { requireScope } from '../../../../../services/access'
import { closeSessions } from '../../../../../services/people'
import { apiData, apiError } from '../../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.edit')
  const closed = await closeSessions({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!, getRouterParam(event, 'sid')!)
  if (!closed) return apiError(event, 404, 'not_found', 'Сесію не знайдено або вже закрито')
  return apiData({ closed })
})
