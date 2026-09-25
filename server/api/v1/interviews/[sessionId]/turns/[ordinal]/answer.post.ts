import { requireAccess } from '../../../../../../services/access'
import { answerTurn } from '../../../../../../services/interview/session'
import { interviewAnswerSchema } from '../../../../../../../shared/schemas/interview'
import { apiData } from '../../../../../../utils/apiResponse'
import { clientIp } from '../../../../../../utils/authCookies'
import { interviewFail, interviewValidationFail } from '../../../../../../utils/interviewErrors'

/**
 * POST /interviews/:sessionId/turns/:ordinal/answer — ответ реплики (`docs/v2/30` §10 `{mode,
 * media_id?, text?}`): голосом (запись уже в S3), текстом или молчанием после трёх подсказок.
 * Отвечает следующей репликой; ответ на последнюю завершает сессию.
 */
export default defineEventHandler(async (event) => {
  const a = await requireAccess(event)
  const p = interviewAnswerSchema.safeParse(await readBody(event))
  if (!p.success) return interviewValidationFail(event, p.error)
  const ordinal = Number(getRouterParam(event, 'ordinal'))
  if (!Number.isInteger(ordinal) || ordinal < 1) return interviewFail(event, 'turn_closed')
  const r = await answerTurn({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'sessionId')!, ordinal, p.data, {
    ip: clientIp(event), userAgent: getHeader(event, 'user-agent') ?? null,
  })
  return r.ok ? apiData(r.session) : interviewFail(event, r.code)
})
