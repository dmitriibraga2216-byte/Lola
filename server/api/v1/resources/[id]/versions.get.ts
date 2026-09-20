import { requireScope } from '../../../../services/access'
import { listResourceVersions } from '../../../../services/resources'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.view')
  const r = await listResourceVersions({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Ресурс не знайдено')
  return apiData(r)
})
