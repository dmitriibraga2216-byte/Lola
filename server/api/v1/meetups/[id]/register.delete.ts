import { requireScope } from '../../../../services/access'
import { unregister } from '../../../../services/meetups'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.enroll')
  const r = await unregister({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, a.userId)
  if (!r.ok) return apiError(event, r.code === 'not_found' ? 404 : 409, `meetup.${r.code}`, r.code === 'not_found' ? 'Запису немає' : 'Скасувати запис уже не можна — зверніться до тренера')
  return apiData(r)
})
