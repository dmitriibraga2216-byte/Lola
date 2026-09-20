import { requireScope } from '../../../../services/access'
import { listTelegramConnections } from '../../../../services/telegram'
import { apiData } from '../../../../utils/apiResponse'

/**
 * GET /logs/notifications/telegram — вкладка «Telegram» журналу сповіщень (docs/04 §4.14,
 * docs/28 «Spec 22» отк. (4), D-003): список підключень `telegram_chat_id`/`telegram_blocked`
 * по активних людях тенанта. Живий знімок стану, не подієвий журнал — окремий шлях
 * поруч із `/logs/notifications`, а не через `LOG_KINDS`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'audit.view')
  return apiData({ rows: await listTelegramConnections({ tenantId: a.tenantId, actorId: a.userId }) })
})
