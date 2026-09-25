import { requireScope } from '../../../services/access'
import { getScenario } from '../../../services/interview/scenarios'
import { apiData } from '../../../utils/apiResponse'
import { scenarioFail } from '../../../utils/interviewErrors'

/** GET /interview-scenarios/:id — сценарий с критериями (`docs/v2/30` §6.1–§6.2); чужой тенант — `404`. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'interview.configure')
  const r = await getScenario({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  return r ? apiData(r) : scenarioFail(event, 'not_found')
})
