import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { respond } from '../../../../../services/surveys'
import { apiData, apiError } from '../../../../../utils/apiResponse'
const schema = z.object({ answers: z.record(z.unknown()), enrollmentId: z.string().uuid().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невірні відповіді')
  const r = await respond({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.answers, p.data.enrollmentId)
  if (!r.ok) {
    if (r.code === 'incomplete') return apiError(event, 422, 'survey.incomplete', 'Дайте відповідь на обовʼязкові питання', { missing: r.missing })
    if (r.code === 'already') return apiError(event, 409, 'survey.already', 'Ви вже відповіли')
    if (r.code === 'closed') return apiError(event, 422, 'survey.closed', 'Опитування закрито')
    return apiError(event, 404, 'not_found', 'Опитування не знайдено')
  }
  return apiData(r)
})
