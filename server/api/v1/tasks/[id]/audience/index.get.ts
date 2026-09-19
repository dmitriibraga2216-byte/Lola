import { audienceQuerySchema } from '../../../../../../shared/schemas/assignments'
import { requireScope } from '../../../../../services/access'
import { listAudience } from '../../../../../services/tasks'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** GET /tasks/:id/audience — Всі · Призначено · Не призначено, фильтры и «Спосіб призначення» (docs/15 §14.4). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = audienceQuerySchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри', { issues: p.error.issues })
  const r = await listAudience({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Призначення не знайдено')
  return apiData(r)
})
