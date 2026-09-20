import { requireScope } from '../../../../services/access'
import { deleteResource } from '../../../../services/resources'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.archive')
  const r = await deleteResource({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Ресурс не знайдено')
    return apiError(event, 422, 'resource.in_use', `Ресурс використовується у курсах (${r.usedInCourses}) — спочатку приберіть його з планів`)
  }
  return apiData({ ok: true })
})
