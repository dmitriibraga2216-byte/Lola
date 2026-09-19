import { eq } from 'drizzle-orm'
import { requireScope } from '../../../../services/access'
import { withTenant } from '../../../../utils/withTenant'
import { notificationTemplates } from '../../../../db/schema'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** «Повернути стандартний текст»: удалить переопределение тенанта. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.notifications')
  const rows = await withTenant(a.tenantId, a.userId, tx => tx.delete(notificationTemplates).where(eq(notificationTemplates.id, getRouterParam(event, 'id')!)).returning({ id: notificationTemplates.id }))
  if (!rows.length) return apiError(event, 404, 'not_found', 'Шаблон не знайдено')
  return apiData({ ok: true })
})
