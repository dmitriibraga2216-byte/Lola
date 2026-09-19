import { requireScope } from '../../../services/access'
import { createLinkToken } from '../../../services/telegram'
import { apiData } from '../../../utils/apiResponse'
/** Ссылка привязки Telegram для текущего пользователя (docs/04 §4.12). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData(await createLinkToken({ tenantId: a.tenantId, actorId: a.userId }))
})
