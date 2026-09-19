import { templateSchema } from '../../../../../shared/schemas/assignments'
import { requireScope } from '../../../../services/access'
import { withTenant } from '../../../../utils/withTenant'
import { notificationTemplates } from '../../../../db/schema'
import { recordAudit } from '../../../../services/audit'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.notifications')
  const p = templateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте шаблон', { issues: p.error.issues })
  const row = await withTenant(a.tenantId, a.userId, async (tx) => {
    const [r] = await tx.insert(notificationTemplates).values({ tenantId: a.tenantId, ...p.data }).onConflictDoUpdate({
      target: [notificationTemplates.tenantId, notificationTemplates.code, notificationTemplates.channel, notificationTemplates.locale],
      set: { subject: p.data.subject ?? null, body: p.data.body, isEnabled: p.data.isEnabled, updatedAt: new Date() },
    }).returning()
    await recordAudit(tx, { tenantId: a.tenantId, actorId: a.userId, action: 'notification_template.upsert', entity: 'notification_template', entityId: r!.id, after: { code: p.data.code } })
    return r!
  })
  return apiData(row)
})
