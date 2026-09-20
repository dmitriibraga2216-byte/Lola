import { sessionTickSchema } from '../../../../../shared/schemas/meetupSessions'
import { requireScope } from '../../../../services/access'
import { tickWatch } from '../../../../services/meetupSessions'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** POST /meetup-sessions/:id/tick — тік перегляду вебінару (docs/18 Г-18.2): сервер сам рахує секунди. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.enroll')
  const p = sessionTickSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте тік')
  const r = await tickWatch({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.seconds)
  if (!r.ok) return apiError(event, 404, 'not_found', 'Ви не записані на цю сесію')
  return apiData(r)
})
