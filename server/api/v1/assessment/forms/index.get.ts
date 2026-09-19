import { requireScope } from '../../../../services/access'
import { listForms } from '../../../../services/assessment'
import { apiData } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.run')
  return apiData(await listForms({ tenantId: a.tenantId, actorId: a.userId }))
})
