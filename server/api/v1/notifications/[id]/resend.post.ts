import { requireScope } from '../../../../services/access'
import { resend } from '../../../../services/notifications'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.notifications')
  const ok = await resend({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!ok) return apiError(event, 404, 'not_found', 'Сповіщення не знайдено')
  return apiData({ ok: true })
})
