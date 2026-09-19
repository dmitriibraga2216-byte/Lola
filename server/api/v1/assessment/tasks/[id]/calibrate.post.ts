import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { calibrateAnswer } from '../../../../../services/assessment'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.team')
  const p = z.object({ criterionId: z.string().uuid(), value: z.number(), comment: z.string().min(5).max(1000) }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Коригування — лише з коментарем (від 5 символів)')
  const r = await calibrateAnswer({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.criterionId, p.data.value, p.data.comment)
  if (!r) return apiError(event, 409, 'bad_status', 'Калібрування недоступне: не ваша оцінка або цикл не на калібруванні')
  return apiData(r)
})
