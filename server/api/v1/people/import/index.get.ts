import { requireScope } from '../../../../services/access'
import { listImportJobs } from '../../../../services/importPeople'
import { apiData } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.import')
  return apiData(await listImportJobs({ tenantId: access.tenantId, actorId: access.userId }))
})
