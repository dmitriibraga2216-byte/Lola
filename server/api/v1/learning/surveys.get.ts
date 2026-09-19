import { requireScope } from '../../../services/access'
import { mySurveys } from '../../../services/surveys'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData(await mySurveys({ tenantId: a.tenantId, actorId: a.userId }))
})
