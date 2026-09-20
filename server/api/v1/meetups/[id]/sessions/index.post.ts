import { sessionCreateSchema } from '../../../../../../shared/schemas/meetupSessions'
import { requireScope } from '../../../../../services/access'
import { createSession } from '../../../../../services/meetupSessions'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** POST /meetups/:id/sessions — нова сесія заняття/вебінару (docs/18 §14.1): сесія належить назначенню, не картці. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.manage')
  const p = sessionCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте сесію', { issues: p.error.issues })
  const r = await createSession({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    if (r.code === 'meetup_not_found') return apiError(event, 404, 'not_found', 'Заняття чи вебінар не знайдено')
    return apiError(event, 422, 'validation_failed', 'Призначення належить іншій картці')
  }
  return apiData(r.session)
})
