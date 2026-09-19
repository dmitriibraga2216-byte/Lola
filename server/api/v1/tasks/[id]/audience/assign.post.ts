import { audienceAssignSchema } from '../../../../../../shared/schemas/assignments'
import { requireScope } from '../../../../../services/access'
import { assignAudience } from '../../../../../services/tasks'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** POST /tasks/:id/audience/assign — `{userIds[]}` («Призначити вибраним») или `{filter}` (конструктор). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = audienceAssignSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Оберіть людей або задайте умову', { issues: p.error.issues })
  const r = await assignAudience({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Призначення не знайдено')
    return apiError(event, 422, 'assignment.empty_audience', 'Під умову не підпадає жодна людина')
  }
  return apiData(r)
})
