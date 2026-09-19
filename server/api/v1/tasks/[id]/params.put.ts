import { requireScope } from '../../../../services/access'
import { putTaskParams } from '../../../../services/tasks'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** PUT /tasks/:id/params — пять групп параметров, схема по типу контента назначения (docs/15 §14.3). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const r = await putTaskParams({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, await readBody(event))
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Призначення не знайдено')
    return apiError(event, 400, 'validation_failed', r.issues?.[0]?.message ?? 'Перевірте параметри: для цього типу контенту частина полів недоступна', { issues: r.issues })
  }
  return apiData(r.data)
})
