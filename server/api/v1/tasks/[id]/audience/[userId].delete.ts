import { requireScope } from '../../../../../services/access'
import { removeFromAudience } from '../../../../../services/tasks'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** DELETE /tasks/:id/audience/:userId — снятие назначения (cancelled_at, не удаление). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const r = await removeFromAudience({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, getRouterParam(event, 'userId')!)
  if (!r.ok) return apiError(event, 404, 'not_found', 'Призначення не знайдено')
  return apiData(r)
})
