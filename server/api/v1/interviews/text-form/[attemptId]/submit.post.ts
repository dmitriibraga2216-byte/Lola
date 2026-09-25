import { requireAccess } from '../../../../../services/access'
import { submitTextForm } from '../../../../../services/interview/candidate'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { interviewFail } from '../../../../../utils/interviewErrors'

/** POST /interviews/text-form/:attemptId/submit — отправить письменную форму на ручную проверку (`docs/v2/30` §7.5). */
export default defineEventHandler(async (event) => {
  const a = await requireAccess(event)
  const r = await submitTextForm({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'attemptId')!)
  if (r.ok) return apiData({ status: r.status })
  if (r.code === 'not_found') return interviewFail(event, 'not_found')
  if (r.code === 'incomplete') return apiError(event, 422, 'attempt.incomplete', 'Дайте відповідь на всі питання', { missing: r.missing })
  return apiError(event, 423, 'attempt.locked', 'Відповіді вже надіслано')
})
