import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { cancelMeetup } from '../../../../services/meetups'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.manage')
  const p = z.object({ reason: z.string().min(10, 'Причина від 10 символів').max(500), notify: z.boolean().optional(), alternativeId: z.string().uuid().nullable().optional() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Вкажіть причину')
  const r = await cancelMeetup({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 409, 'bad_status', 'Заняття вже завершено або скасовано')
  return apiData(r)
})
