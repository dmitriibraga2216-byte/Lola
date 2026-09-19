import { requireScope } from '../../../services/access'
import { myExports } from '../../../services/reportExports'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.team')
  return apiData(await myExports({ tenantId: a.tenantId, actorId: a.userId }))
})
