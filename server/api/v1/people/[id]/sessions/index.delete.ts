import { requireScope } from '../../../../../services/access'
import { closeSessions } from '../../../../../services/people'
import { apiData } from '../../../../../utils/apiResponse'

/** Закрити всі сесії людини (docs/16 §7.4). */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.edit')
  const closed = await closeSessions({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!)
  return apiData({ closed })
})
