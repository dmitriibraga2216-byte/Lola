import { requireScope } from '../../../../services/access'
import { markRead } from '../../../../services/platformAnnouncements'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** POST /platform-announcements/:id/read (docs/04 §4.13): «Прочитано»; не адресованное пространству — 404 (CLAUDE.md п. 15). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const r = await markRead({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (r === 'not_found') return apiError(event, 404, 'not_found', 'Оголошення не знайдено')
  return apiData({ ok: true })
})
