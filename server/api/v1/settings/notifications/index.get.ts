import { requireScope } from '../../../../services/access'
import { withTenant } from '../../../../utils/withTenant'
import { notificationTemplates } from '../../../../db/schema'
import { DEFAULT_TEMPLATES } from '../../../../services/notifications'
import { apiData } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.notifications')
  const custom = await withTenant(a.tenantId, a.userId, tx => tx.select().from(notificationTemplates))
  return apiData({ defaults: DEFAULT_TEMPLATES, custom })
})
