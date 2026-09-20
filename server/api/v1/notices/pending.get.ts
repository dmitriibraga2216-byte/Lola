import { requireScope } from '../../../services/access'
import { pendingForUser } from '../../../services/notices'
import { apiData } from '../../../utils/apiResponse'

/** GET /notices/pending — что показать при входе: назначенные и не подтверждённые (docs/21 §5.4). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData(await pendingForUser({ tenantId: a.tenantId, actorId: a.userId }))
})
