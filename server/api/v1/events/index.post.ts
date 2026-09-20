import { eventSchema } from '../../../../shared/schemas/hub'
import { requireScope } from '../../../services/access'
import { createEvent } from '../../../services/hubExtra'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.manage')
  const p = eventSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте подію', { issues: p.error.issues })
  if (new Date(p.data.startsAt).getTime() <= Date.now()) return apiError(event, 422, 'validation_failed', 'Подія не може починатися в минулому')
  if (p.data.endsAt && new Date(p.data.endsAt) <= new Date(p.data.startsAt)) return apiError(event, 422, 'validation_failed', 'Завершення має бути пізніше початку')
  return apiData(await createEvent({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
