import { requireAccess } from '../../../../../services/access'
import { decideConsent } from '../../../../../services/interview/candidate'
import { interviewConsentSchema } from '../../../../../../shared/schemas/interview'
import { apiData } from '../../../../../utils/apiResponse'
import { clientIp } from '../../../../../utils/authCookies'
import { interviewFail, interviewValidationFail } from '../../../../../utils/interviewErrors'

/**
 * POST /interviews/entry/:quizId/consent — «Погоджуюсь і починаю» или «Не погоджуюсь»
 * (`docs/v2/30` §5.1, §6.3, §7.4, §7.5, §10). Пишется строка `interview_consents` с редакцией и
 * хешем текста, IP и браузером. Отказ — альтернатива сценария, рекрутеру `interview_declined`,
 * сессия не создаётся (`30` §13 к. 2). Другая редакция текста — `422 interview_consent.invalid`,
 * повторное решение — `409 interview_consent.already_decided`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireAccess(event)
  const p = interviewConsentSchema.safeParse(await readBody(event))
  if (!p.success) return interviewValidationFail(event, p.error)
  const r = await decideConsent({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'quizId')!, p.data, {
    ip: clientIp(event), userAgent: getHeader(event, 'user-agent') ?? null,
  })
  return r.ok ? apiData(r) : interviewFail(event, r.code)
})
