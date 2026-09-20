import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { viewResource } from '../../../../services/resources'
import { apiData, apiError } from '../../../../utils/apiResponse'

const querySchema = z.object({ assignmentId: z.string().uuid().optional() })

/**
 * Ресурс для ученика вне курса: текущая версия, только при доступе по группам; чужой тенант или нет доступа — 404.
 * `?assignmentId=` — версия, закреплённая назначением на момент выдачи (D-007).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const q = querySchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Некоректний assignmentId')
  const r = await viewResource({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, q.data)
  if (!r) return apiError(event, 404, 'not_found', 'Ресурс не знайдено')
  return apiData(r)
})
