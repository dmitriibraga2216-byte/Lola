import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { declineTask } from '../../../../../services/assessment'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.own')
  const p = z.object({ reason: z.string().min(3).max(300) }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть причину')
  const r = await declineTask({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.reason)
  if (!r) return apiError(event, 409, 'bad_status', 'Завдання не можна відхилити')
  return apiData(r)
})
