import { requireScope } from '../../../../../services/access'
import { getImportJob } from '../../../../../services/importPeople'
import { apiData, apiError } from '../../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.import')
  const job = await getImportJob(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
  )
  if (!job) return apiError(event, 404, 'not_found', 'Імпорт не знайдено')
  return apiData(job)
})
