import { requireScope } from '../../../../services/access'
import { inbox } from '../../../../services/notifications'
import { apiData } from '../../../../utils/apiResponse'
/** Колокольчик (docs/23 §5.5): последние 50, непрочитанные. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData(await inbox({ tenantId: a.tenantId, actorId: a.userId }))
})
