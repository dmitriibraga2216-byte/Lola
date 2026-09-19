import { requireScope } from '../../../services/access'
import { listComplexTests } from '../../../services/complexTests'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'complextest.manage')
  return apiData(await listComplexTests({ tenantId: a.tenantId, actorId: a.userId }))
})
