import { requireScope } from '../../../../../services/access'
import { assertPersonAccess } from '../../../../../services/personGuard'
import { closeSessions } from '../../../../../services/people'
import { apiData, apiError } from '../../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.edit')
  await assertPersonAccess(access, 'people.edit', getRouterParam(event, 'id')!, { sensitive: true })
  const closed = await closeSessions({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!, getRouterParam(event, 'sid')!)
  if (!closed) return apiError(event, 404, 'not_found', 'Сесію не знайдено або вже закрито')
  return apiData({ closed })
})
