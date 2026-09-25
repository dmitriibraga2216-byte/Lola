import { requireScope } from '../../../../../services/access'
import { updateCriterion } from '../../../../../services/interview/scenarios'
import { interviewCriterionUpdateSchema } from '../../../../../../shared/schemas/interview'
import { apiData } from '../../../../../utils/apiResponse'
import { interviewValidationFail, scenarioFail } from '../../../../../utils/interviewErrors'

/** PUT /interview-scenarios/:id/criteria/:criterionId — правка критерия черновика (`docs/v2/30` §6.2). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'interview.configure')
  const p = interviewCriterionUpdateSchema.safeParse(await readBody(event))
  if (!p.success) return interviewValidationFail(event, p.error)
  const r = await updateCriterion({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, getRouterParam(event, 'criterionId')!, p.data)
  return r.ok ? apiData(r.criterion) : scenarioFail(event, r.code)
})
