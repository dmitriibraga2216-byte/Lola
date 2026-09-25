import { requireAccess } from '../../../../services/access'
import { pause } from '../../../../services/interview/session'
import { interviewFail } from '../../../../utils/interviewErrors'

/**
 * POST /interviews/:sessionId/pause — вкладку закрыли или ушли со страницы (`docs/v2/30` §7.12):
 * `paused`, `disconnects + 1`. Шлётся `fetch(…, { keepalive: true })` на `pagehide` — с тем же
 * CSRF-заголовком, что и остальные мутации.
 */
export default defineEventHandler(async (event) => {
  const a = await requireAccess(event)
  const ok = await pause({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'sessionId')!)
  if (!ok) return interviewFail(event, 'not_found')
  setResponseStatus(event, 204)
  return null
})
