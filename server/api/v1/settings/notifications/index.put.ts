import { and, eq } from 'drizzle-orm'
import { templateSchema } from '../../../../../shared/schemas/assignments'
import { requireScope } from '../../../../services/access'
import { withTenant } from '../../../../utils/withTenant'
import { notificationTemplateVersions, notificationTemplates } from '../../../../db/schema'
import { recordAudit } from '../../../../services/audit'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** Шаблон тенанта (docs/23 §3.1): правка текста создаёт версию; отправленное ссылается на свою. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.notifications')
  const p = templateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте шаблон', { issues: p.error.issues })
  const d = p.data
  const row = await withTenant(a.tenantId, a.userId, async (tx) => {
    const [before] = await tx.select().from(notificationTemplates).where(and(eq(notificationTemplates.code, d.code), eq(notificationTemplates.channel, d.channel), eq(notificationTemplates.locale, d.locale)))
    const textChanged = !before || before.body !== d.body || (before.subject ?? null) !== (d.subject ?? null) || (before.bodyMjml ?? null) !== (d.bodyMjml ?? null)
    const version = before ? (textChanged ? before.version + 1 : before.version) : 1
    const set = {
      subject: d.subject ?? null, body: d.body, isEnabled: d.isEnabled, buttons: d.buttons ?? [], isMandatory: d.isMandatory ?? false, throttle: d.throttle ?? null, escalateAfterHours: d.escalateAfterHours ?? null, ignoreQuietHours: d.ignoreQuietHours ?? false, version, updatedAt: new Date(),
      bodyMjml: d.bodyMjml ?? null, imageKey: d.imageKey ?? null, telegramImageKey: d.telegramImageKey ?? null,
    }
    const [r] = await tx.insert(notificationTemplates).values({ tenantId: a.tenantId, code: d.code, channel: d.channel, locale: d.locale, ...set }).onConflictDoUpdate({
      target: [notificationTemplates.tenantId, notificationTemplates.code, notificationTemplates.channel, notificationTemplates.locale], set,
    }).returning()
    if (textChanged) await tx.insert(notificationTemplateVersions).values({ tenantId: a.tenantId, templateId: r!.id, version, subject: d.subject ?? null, body: d.body, bodyMjml: d.bodyMjml ?? null, authorId: a.userId })
    await recordAudit(tx, { tenantId: a.tenantId, actorId: a.userId, action: 'notification_template.upsert', entity: 'notification_template', entityId: r!.id, after: { code: d.code, version } })
    return r!
  })
  return apiData(row)
})
