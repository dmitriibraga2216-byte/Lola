import { requireScope } from '../../../../../../services/access'
import { applyCsv } from '../../../../../../services/tasks'
import { apiData, apiError } from '../../../../../../utils/apiResponse'

/** Применить предпросмотр CSV по подтверждению. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const r = await applyCsv({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, getRouterParam(event, 'jobId')!)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Попередній перегляд не знайдено')
    return apiError(event, 409, 'import.applied', 'Цей файл уже застосовано')
  }
  return apiData(r)
})
