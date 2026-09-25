import { requireAccess } from '../../../../services/access'
import { finishSession } from '../../../../services/interview/session'
import { apiData } from '../../../../utils/apiResponse'
import { clientIp } from '../../../../utils/authCookies'
import { interviewFail } from '../../../../utils/interviewErrors'

/**
 * POST /interviews/:sessionId/finish — «Завершити» (`docs/v2/30` §4, §10): нужна хотя бы одна
 * отвеченная реплика (`409 no_answers`). Попытка уходит обычным путём теста, затем расшифровка
 * и оценка — фоном.
 */
export default defineEventHandler(async (event) => {
  const a = await requireAccess(event)
  const r = await finishSession({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'sessionId')!, {
    ip: clientIp(event), userAgent: getHeader(event, 'user-agent') ?? null,
  })
  return r.ok ? apiData(r.session) : interviewFail(event, r.code)
})
