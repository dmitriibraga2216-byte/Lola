import { requireScope } from '../../../../services/access'
import { surveyReport } from '../../../../services/surveys'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'survey.manage')
  const r = await surveyReport({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Опитування не знайдено')
  return apiData(r)
})
