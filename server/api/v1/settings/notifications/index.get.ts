import { requireScope } from '../../../../services/access'
import { withTenant } from '../../../../utils/withTenant'
import { notificationTemplates } from '../../../../db/schema'
import { DEFAULT_TEMPLATES, DEFAULT_TEMPLATE_CHANNELS } from '../../../../services/notifications'
import { apiData } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.notifications')
  const custom = await withTenant(a.tenantId, a.userId, tx => tx.select().from(notificationTemplates))
  // docs/23 §13.1 (докс/31 залишок): дефолтний стан тумблерів Email/Telegram, поки нема кастомного рядка каналу
  return apiData({ defaults: DEFAULT_TEMPLATES, defaultChannels: DEFAULT_TEMPLATE_CHANNELS, custom })
})
