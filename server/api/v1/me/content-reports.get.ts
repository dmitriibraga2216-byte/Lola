import { requireScope } from '../../../services/access'
import { myReports } from '../../../services/contentIssues'
import { apiData } from '../../../utils/apiResponse'

/**
 * GET /me/content-reports — «Мої повідомлення про помилки» (docs/v2/36 §5.5, §10).
 * Человек видит свои жалобы и их статус простыми словами; разбор и очередь автора — PR-24.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'content_issue.report')
  return apiData(await myReports({ tenantId: a.tenantId, actorId: a.userId }))
})
