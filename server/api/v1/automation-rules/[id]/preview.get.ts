import { requireScope } from '../../../../services/access'
import { previewRule } from '../../../../services/automation'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** «Буде призначено: N людей на зараз» (docs/04 §4.10) — без побочных эффектов. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const r = await previewRule({ tenantId: a.tenantId, actorId: a.userId }, { ruleId: getRouterParam(event, 'id')! })
  if (!r) return apiError(event, 404, 'not_found', 'Правило не знайдено')
  return apiData(r)
})
