import { eventSchema } from '../../../../../shared/schemas/hub'
import { requireScope } from '../../../../services/access'
import { updateEvent } from '../../../../services/hubExtra'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.manage')
  const p = eventSchema.partial().safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте подію', { issues: p.error.issues })
  const r = await updateEvent({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Подію не знайдено')
  return apiData(r)
})
