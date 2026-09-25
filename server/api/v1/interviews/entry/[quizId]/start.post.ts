import { requireAccess } from '../../../../../services/access'
import { startSession } from '../../../../../services/interview/candidate'
import { interviewStartSchema } from '../../../../../../shared/schemas/interview'
import { apiData } from '../../../../../utils/apiResponse'
import { clientIp } from '../../../../../utils/authCookies'
import { interviewAiFail, interviewFail, interviewValidationFail } from '../../../../../utils/interviewErrors'

/**
 * POST /interviews/entry/:quizId/start — старт сессии (`docs/v2/30` §4, §10 `{answer_mode}`).
 * Без согласия по действующей версии сценария — `409 interview_consent.required` (проверка на
 * сервере, `30` §13 к. 1). Резервирует одну операцию `ai_interview_ops` на сессию; исчерпанная
 * ось — `409 limit_exceeded`, истёкший ИИ — `409 ai.unavailable`, в обоих случаях с
 * `details.alternative`: сессия не стартует, кандидату предлагается альтернатива (`30` §13 к. 7).
 * Идущая сессия не дублируется — возвращается она же (`resumed: true`).
 */
export default defineEventHandler(async (event) => {
  const a = await requireAccess(event)
  const p = interviewStartSchema.safeParse(await readBody(event))
  if (!p.success) return interviewValidationFail(event, p.error)
  const r = await startSession({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'quizId')!, p.data, {
    ip: clientIp(event), userAgent: getHeader(event, 'user-agent') ?? null,
  })
  if (r.ok) return apiData(r)
  if (r.code === 'ai_unavailable' || r.code === 'limit_exceeded') return interviewAiFail(event, r)
  return interviewFail(event, r.code)
})
