import { requireScope } from '../../../../services/access'
import { personActivity } from '../../../../services/people'
import { apiData } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.view')
  return apiData(await personActivity({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!))
})
