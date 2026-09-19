import { requireScope } from '../../../../services/access'
import { duplicateProgram } from '../../../../services/programs'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.manage')
  const r = await duplicateProgram({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Програму не знайдено')
  return apiData(r)
})
