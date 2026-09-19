import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { setAttendance } from '../../../../services/meetups'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.attendance')
  const p = z.object({ userId: z.string().uuid(), status: z.enum(['attended', 'missed', 'excused']), reason: z.string().max(300).optional() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте відмітку')
  if (p.data.status === 'excused' && !(p.data.reason ?? '').trim()) return apiError(event, 422, 'validation_failed', 'Вкажіть поважну причину')
  const r = await setAttendance({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Людини немає у списку')
  return apiData(r)
})
