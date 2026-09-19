import { requireScope } from '../../../../../services/access'
import { startComplex } from '../../../../../services/complexTests'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.attempt')
  const r = await startComplex({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) return apiError(event, r.code === 'not_found' ? 404 : 409, `complex.${r.code}`, r.code === 'attempts_exhausted' ? 'Спроби вичерпано' : r.code === 'in_progress' ? 'Є незавершена спроба' : 'Тест не знайдено', { attemptId: r.attemptId })
  return apiData(r)
})
