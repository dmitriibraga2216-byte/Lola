import { sessionCancelSchema } from '../../../../../shared/schemas/meetupSessions'
import { requireScope } from '../../../../services/access'
import { cancelSession } from '../../../../services/meetupSessions'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.manage')
  const p = sessionCancelSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Вкажіть причину')
  const r = await cancelSession({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 409, 'bad_status', 'Сесія вже завершена або скасована')
  return apiData(r)
})
