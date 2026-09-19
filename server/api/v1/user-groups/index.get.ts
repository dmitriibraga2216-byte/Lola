import { requireScope } from '../../../services/access'
import { listGroups } from '../../../services/groups'
import { apiData } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.view')
  return apiData(await listGroups({ tenantId: access.tenantId, actorId: access.userId }))
})
