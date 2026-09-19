import { requireScope } from '../../../../services/access'
import { register } from '../../../../services/meetups'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.enroll')
  const r = await register({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, a.userId)
  if (!r.ok) {
    const msg: Record<string, string> = { not_found: 'Заняття не знайдено', closed: 'Запис закрито', full: 'Місць немає', already: 'Ви вже записані' }
    return apiError(event, r.code === 'not_found' ? 404 : 409, `meetup.${r.code}`, msg[r.code]!)
  }
  return apiData(r)
})
