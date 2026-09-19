import { requireScope } from '../../../services/access'
import { listSurveys } from '../../../services/surveys'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'survey.manage')
  return apiData(await listSurveys({ tenantId: a.tenantId, actorId: a.userId }))
})
