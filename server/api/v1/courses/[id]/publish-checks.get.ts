import { requireScope } from '../../../../services/access'
import { publishChecks } from '../../../../services/courses'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'course.publish')
  const checks = await publishChecks(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
  )
  if (!checks) return apiError(event, 404, 'not_found', 'Курс не знайдено')
  return apiData(checks)
})
