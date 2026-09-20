import { requireScope } from '../../../services/access'
import { listMine } from '../../../services/notices'
import { apiData } from '../../../utils/apiResponse'

/** GET /notices/mine — объявления, назначенные человеку, с отметкой подтверждения. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData(await listMine({ tenantId: a.tenantId, actorId: a.userId }))
})
