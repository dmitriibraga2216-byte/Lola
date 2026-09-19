import { requireScope } from '../../../../services/access'
import { dismissChanged } from '../../../../services/tasks'
import { apiData } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  return apiData(await dismissChanged({ tenantId: a.tenantId, actorId: a.userId }))
})
