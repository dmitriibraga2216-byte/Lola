import { requireScope } from '../../../../services/access'
import { listCriteria } from '../../../../services/interview/scenarios'
import { apiData } from '../../../../utils/apiResponse'
import { scenarioFail } from '../../../../utils/interviewErrors'

/** GET /interview-scenarios/:id/criteria — критерии сценария (`docs/v2/30` §6.2; `interview.configure`). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'interview.configure')
  const r = await listCriteria({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  return r ? apiData(r) : scenarioFail(event, 'not_found')
})
