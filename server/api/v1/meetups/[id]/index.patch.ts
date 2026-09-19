import { requireScope } from '../../../../services/access'
import { updateMeetup } from '../../../../services/meetups'
import { meetupSchema } from '../index.post'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.manage')
  const p = meetupSchema.partial().safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте заняття', { issues: p.error.issues })
  if (p.data.startsAt && p.data.endsAt && new Date(p.data.endsAt) <= new Date(p.data.startsAt)) return apiError(event, 422, 'validation_failed', 'Завершення має бути пізніше початку')
  const m = await updateMeetup({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!m) return apiError(event, 409, 'bad_status', 'Заняття завершено або скасовано')
  return apiData(m)
})
