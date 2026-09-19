import { requireScope } from '../../../../services/access'
import { applyPositionProfile } from '../../../../services/developmentExtra'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** «Застосувати до людей на посаді» (docs/19 §5.5): назначения обязательного контента профиля. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const r = await applyPositionProfile({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Профіль не знайдено або вимкнено')
  return apiData(r)
})
