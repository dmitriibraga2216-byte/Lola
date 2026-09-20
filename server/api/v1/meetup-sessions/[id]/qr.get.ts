import { requireScope } from '../../../../services/access'
import { currentQr } from '../../../../services/meetupSessions'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.attendance')
  const r = await currentQr({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'QR не використовується для цієї сесії')
  return apiData(r)
})
