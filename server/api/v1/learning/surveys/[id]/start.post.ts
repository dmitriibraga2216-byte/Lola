import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { startSurvey } from '../../../../../services/surveys'
import { apiData, apiError } from '../../../../../utils/apiResponse'
/** Початок/продовження опитування: сервер віддає поточне питання — граф «з умовами» клієнт не бачить. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = z.object({ enrollmentId: z.string().uuid().optional() }).safeParse(await readBody(event) ?? {})
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невірні дані')
  const r = await startSurvey({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.enrollmentId)
  if (!r.ok) {
    if (r.code === 'already') return apiError(event, 409, 'survey.already', 'Ви вже відповіли')
    if (r.code === 'closed') return apiError(event, 422, 'survey.closed', 'Опитування закрито')
    return apiError(event, 404, 'not_found', 'Опитування не знайдено')
  }
  return apiData(r)
})
