import { requireScope } from '../../../../../services/access'
import { assertPersonAccess } from '../../../../../services/personGuard'
import { closeSessions } from '../../../../../services/people'
import { apiData } from '../../../../../utils/apiResponse'

/** Закрити всі сесії людини (docs/16 §7.4). */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.edit')
  await assertPersonAccess(access, 'people.edit', getRouterParam(event, 'id')!, { sensitive: true })
  const closed = await closeSessions({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!)
  return apiData({ closed })
})
