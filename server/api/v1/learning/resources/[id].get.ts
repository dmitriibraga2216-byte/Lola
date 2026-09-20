import { requireScope } from '../../../../services/access'
import { viewResource } from '../../../../services/resources'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** Ресурс для ученика вне курса: текущая версия, только при доступе по группам; чужой тенант или нет доступа — 404. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const r = await viewResource({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Ресурс не знайдено')
  return apiData(r)
})
