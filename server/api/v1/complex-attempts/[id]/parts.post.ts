import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { startPart } from '../../../../services/complexTests'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.attempt')
  const p = z.object({ quizId: z.string().uuid() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть частину')
  const r = await startPart({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.quizId)
  if (!r.ok) {
    const msg: Record<string, string> = { not_found: 'Спробу не знайдено', expired: 'Час на комплекс вичерпано', locked: 'Спочатку завершіть попередню частину', done: 'Ця частина вже завершена', quiz_error: `Не вдалося почати тест: ${r.detail ?? ''}` }
    return apiError(event, r.code === 'not_found' ? 404 : 409, `complex.${r.code}`, msg[r.code]!)
  }
  return apiData(r)
})
