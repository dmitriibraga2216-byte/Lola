import { requireScope } from '../../../../services/access'
import { addCriterion } from '../../../../services/interview/scenarios'
import { interviewCriterionSchema } from '../../../../../shared/schemas/interview'
import { apiData } from '../../../../utils/apiResponse'
import { interviewValidationFail, scenarioFail } from '../../../../utils/interviewErrors'

/**
 * POST /interview-scenarios/:id/criteria — критерий (`docs/v2/30` §6.2; `interview.configure`):
 * описание 20–500 знаков — определение, которое получает модель и читает человек рядом с баллом.
 * Критерии опубликованной версии не меняются — `409 scenario.published`. `201`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'interview.configure')
  const p = interviewCriterionSchema.safeParse(await readBody(event))
  if (!p.success) return interviewValidationFail(event, p.error)
  const r = await addCriterion({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) return scenarioFail(event, r.code)
  setResponseStatus(event, 201)
  return apiData(r.criterion)
})
