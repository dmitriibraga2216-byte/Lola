import { requireScope } from '../../../services/access'
import { createScenario } from '../../../services/interview/scenarios'
import { interviewScenarioCreateSchema } from '../../../../shared/schemas/interview'
import { apiData } from '../../../utils/apiResponse'
import { interviewValidationFail, scenarioFail } from '../../../utils/interviewErrors'

/**
 * POST /interview-scenarios — новый сценарий-черновик (`docs/v2/30` §6.1; `interview.configure`)
 * для теста вида `interview` (`44` В-12): иначе `422 scenario.quiz_not_interview`. `201`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'interview.configure')
  const p = interviewScenarioCreateSchema.safeParse(await readBody(event))
  if (!p.success) return interviewValidationFail(event, p.error)
  const r = await createScenario({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r.ok) return scenarioFail(event, r.code)
  setResponseStatus(event, 201)
  return apiData(r.scenario)
})
