import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { saveAnswers } from '../../../../../services/assessment'
import { apiData, apiError } from '../../../../../utils/apiResponse'
const schema = z.object({ answers: z.array(z.object({ criterionId: z.string().uuid(), value: z.number().nullable(), comment: z.string().max(2000).nullable().optional(), isNa: z.boolean().optional() })).min(1).max(300) })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.own')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте відповіді')
  const r = await saveAnswers({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.answers)
  if (!r) return apiError(event, 409, 'bad_status', 'Анкету вже надіслано або це не ваше завдання')
  return apiData(r)
})
