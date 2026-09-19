import { requireScope } from '../../../../services/access'
import { getAssignment } from '../../../../services/assignments'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** Карточка из четырёх блоков (docs/15 §14.2). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const r = await getAssignment({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Призначення не знайдено')
  return apiData(r)
})
