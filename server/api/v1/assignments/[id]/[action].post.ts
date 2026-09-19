import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { remindAssignment, setAssignmentStatus } from '../../../../services/assignments'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** POST /assignments/:id/{pause|resume|archive|remind} (docs/15 §10). cancel — отдельный роут с телом. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.cancel')
  const action = z.enum(['pause', 'resume', 'archive', 'remind']).safeParse(getRouterParam(event, 'action'))
  if (!action.success) return apiError(event, 404, 'not_found', 'Невідома дія')
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const id = getRouterParam(event, 'id')!
  if (action.data === 'remind') {
    const n = await remindAssignment(ctx, id)
    if (n == null) return apiError(event, 404, 'not_found', 'Призначення не знайдено')
    return apiData({ reminded: n })
  }
  const r = await setAssignmentStatus(ctx, id, action.data)
  if (!r.ok) return apiError(event, r.code === 'not_found' ? 404 : 409, r.code, r.code === 'not_found' ? 'Призначення не знайдено' : 'Перехід неможливий із поточного статусу')
  return apiData(r)
})
