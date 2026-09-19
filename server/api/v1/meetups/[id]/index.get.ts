import { requireScope, can } from '../../../../services/access'
import { getMeetup } from '../../../../services/meetups'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.view')
  const m = await getMeetup({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, { manage: can(a, 'meetup.manage') || can(a, 'meetup.attendance') })
  if (!m || (m.status === 'draft' && !can(a, 'meetup.manage'))) return apiError(event, 404, 'not_found', 'Заняття не знайдено')
  return apiData(m)
})
