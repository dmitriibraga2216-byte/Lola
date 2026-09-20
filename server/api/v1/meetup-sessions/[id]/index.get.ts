import { requireScope, can } from '../../../../services/access'
import { getSession } from '../../../../services/meetupSessions'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.view')
  const s = await getSession({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, { manage: can(a, 'meetup.manage') || can(a, 'meetup.attendance') })
  if (!s) return apiError(event, 404, 'not_found', 'Сесію не знайдено')
  return apiData(s)
})
