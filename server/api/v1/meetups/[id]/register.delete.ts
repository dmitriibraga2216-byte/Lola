import { requireScope } from '../../../../services/access'
import { unregister } from '../../../../services/meetups'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.enroll')
  const r = await unregister({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, a.userId)
  if (!r.ok) {
    const msg: Record<string, string> = { not_found: 'Запису немає', cancel_deadline_passed: 'Скасувати запис уже не можна — зверніться до тренера', has_sessions: 'Це заняття записується через сесії — оберіть сесію в розкладі' }
    return apiError(event, r.code === 'not_found' ? 404 : 409, `meetup.${r.code}`, msg[r.code]!)
  }
  return apiData(r)
})
