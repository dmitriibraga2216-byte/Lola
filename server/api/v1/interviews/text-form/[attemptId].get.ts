import { requireAccess } from '../../../../services/access'
import { getTextForm } from '../../../../services/interview/candidate'
import { apiData } from '../../../../utils/apiResponse'
import { interviewFail } from '../../../../utils/interviewErrors'

/** GET /interviews/text-form/:attemptId — вопросы письменной формы и сохранённые ответы (`docs/v2/30` §7.5). */
export default defineEventHandler(async (event) => {
  const a = await requireAccess(event)
  const r = await getTextForm({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'attemptId')!)
  return r ? apiData(r) : interviewFail(event, 'not_found')
})
