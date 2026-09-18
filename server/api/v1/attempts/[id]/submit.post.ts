import { requireScope } from '../../../../services/access'
import { submitAttempt } from '../../../../services/attempts'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.attempt')
  const r = await submitAttempt({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Спробу не знайдено')
    if (r.code === 'incomplete') return apiError(event, 422, 'attempt.incomplete', 'Дайте відповідь на всі питання', { missing: r.missing })
    return apiError(event, 423, 'attempt.locked', 'Спроба вже завершена')
  }
  return apiData(r)
})
