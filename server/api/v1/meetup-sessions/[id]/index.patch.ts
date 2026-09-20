import { sessionUpdateSchema } from '../../../../../shared/schemas/meetupSessions'
import { requireScope } from '../../../../services/access'
import { updateSession } from '../../../../services/meetupSessions'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.manage')
  const p = sessionUpdateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте сесію', { issues: p.error.issues })
  const s = await updateSession({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!s) return apiError(event, 409, 'bad_status', 'Сесія завершена або скасована')
  return apiData(s)
})
