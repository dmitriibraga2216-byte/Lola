import { requireAccess } from '../../../../services/access'
import { heartbeat } from '../../../../services/interview/session'
import { interviewHeartbeatSchema } from '../../../../../shared/schemas/interview'
import { apiData } from '../../../../utils/apiResponse'
import { clientIp } from '../../../../utils/authCookies'
import { interviewFail, interviewValidationFail } from '../../../../utils/interviewErrors'

/**
 * POST /interviews/:sessionId/heartbeat — биение раз в 5 секунд (`docs/v2/30` §7.12): «кандидат
 * здесь». Первое биение после паузы или долгого молчания — возврат (`resumed: true`, экран пишет
 * «Зв'язок відновлено, продовжуємо»), молчание дольше порога без паузы — обрыв задним числом.
 */
export default defineEventHandler(async (event) => {
  const a = await requireAccess(event)
  const p = interviewHeartbeatSchema.safeParse((await readBody(event).catch(() => ({}))) ?? {})
  if (!p.success) return interviewValidationFail(event, p.error)
  const r = await heartbeat({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'sessionId')!, p.data, {
    ip: clientIp(event), userAgent: getHeader(event, 'user-agent') ?? null,
  })
  return r.ok ? apiData({ session: r.session, resumed: r.resumed }) : interviewFail(event, r.code)
})
