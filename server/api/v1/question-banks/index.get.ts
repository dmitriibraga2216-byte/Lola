import { requireScope } from '../../../services/access'
import { listBanks } from '../../../services/questions'
import { apiData } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'question.manage')
  return apiData(await listBanks({ tenantId: a.tenantId, actorId: a.userId }))
})
