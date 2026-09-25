import { requireAccess } from '../../../../../../services/access'
import { answerTextForm } from '../../../../../../services/interview/candidate'
import { interviewTextAnswerSchema } from '../../../../../../../shared/schemas/interview'
import { apiData, apiError } from '../../../../../../utils/apiResponse'
import { interviewFail, interviewValidationFail } from '../../../../../../utils/interviewErrors'

/** PUT /interviews/text-form/:attemptId/answers/:questionId — ответ письменной формы, идемпотентно (`docs/v2/30` §7.5). */
export default defineEventHandler(async (event) => {
  const a = await requireAccess(event)
  const p = interviewTextAnswerSchema.safeParse(await readBody(event))
  if (!p.success) return interviewValidationFail(event, p.error)
  const r = await answerTextForm({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'attemptId')!, getRouterParam(event, 'questionId')!, p.data.text)
  if (r.ok) return apiData({ ok: true })
  if (r.code === 'not_found') return interviewFail(event, 'not_found')
  if (r.code === 'deadline') return interviewFail(event, 'expired')
  return apiError(event, 423, 'attempt.locked', 'Відповіді вже надіслано')
})
