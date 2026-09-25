import { requireScope } from '../../../../../services/access'
import { deleteCriterion } from '../../../../../services/interview/scenarios'
import { scenarioFail } from '../../../../../utils/interviewErrors'

/** DELETE /interview-scenarios/:id/criteria/:criterionId — удалить критерий черновика (`docs/v2/30` §6.2); `204`. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'interview.configure')
  const r = await deleteCriterion({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, getRouterParam(event, 'criterionId')!)
  if (!r.ok) return scenarioFail(event, r.code)
  setResponseStatus(event, 204)
  return null
})
