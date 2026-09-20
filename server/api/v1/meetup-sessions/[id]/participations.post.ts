import { sessionParticipationSchema } from '../../../../../shared/schemas/meetupSessions'
import { requireScope } from '../../../../services/access'
import { recordParticipation } from '../../../../services/meetupSessions'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** Участь у вебінарі: від провайдера або вручну тренером (docs/18 §7.6). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.attendance')
  const p = sessionParticipationSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте дані участі')
  const r = await recordParticipation({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.rows, p.data.source)
  if (!r) return apiError(event, 404, 'not_found', 'Сесію не знайдено')
  return apiData(r)
})
