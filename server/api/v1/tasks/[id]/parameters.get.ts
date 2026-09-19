import { requireScope } from '../../../../services/access'
import { getTaskParameterValues } from '../../../../services/tasks'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** Значения «Додаткових параметрів» назначения (docs/15 §14.5). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const r = await getTaskParameterValues({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Призначення не знайдено')
  return apiData(r)
})
