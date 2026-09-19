import { requireScope } from '../../../../services/access'
import { publishProgram } from '../../../../services/programs'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.publish')
  const r = await publishProgram({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) return apiError(event, 422, 'program.invalid', r.problems[0]?.message ?? 'Програму не можна опублікувати', { problems: r.problems })
  return apiData(r)
})
