import { requireScope } from '../../../../services/access'
import { setResourceStatus } from '../../../../services/resources'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** Из архива — в чернетки (docs/11 §4). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.archive')
  const r = await setResourceStatus({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, 'draft')
  if (!r) return apiError(event, 404, 'not_found', 'Ресурс не знайдено')
  return apiData(r)
})
