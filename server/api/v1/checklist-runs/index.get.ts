import { requireScope } from '../../../services/access'
import { myRuns } from '../../../services/checklists'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'checklist.run')
  return apiData(await myRuns({ tenantId: a.tenantId, actorId: a.userId }))
})
