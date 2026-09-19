import { desc, eq } from 'drizzle-orm'
import { requireScope } from '../../../../../services/access'
import { withTenant } from '../../../../../utils/withTenant'
import { notificationTemplateVersions, users } from '../../../../../db/schema'
import { apiData } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.notifications')
  return apiData(await withTenant(a.tenantId, a.userId, tx => tx.select({ version: notificationTemplateVersions.version, body: notificationTemplateVersions.body, subject: notificationTemplateVersions.subject, createdAt: notificationTemplateVersions.createdAt, author: users.fullName })
    .from(notificationTemplateVersions).leftJoin(users, eq(users.id, notificationTemplateVersions.authorId)).where(eq(notificationTemplateVersions.templateId, getRouterParam(event, 'id')!)).orderBy(desc(notificationTemplateVersions.version))))
})
