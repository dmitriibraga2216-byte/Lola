import { requireScope } from '../../../../services/access'
import { listRoutingRules } from '../../../../services/contentIssueRouting'
import { apiData } from '../../../../utils/apiResponse'

/**
 * GET /settings/content-issue-routing-rules — правила адресации жалоб (docs/v2/36 §6.3, §7.5).
 * Читать может каждый, кто разбирает (`content_issue.triage`): автор видит, почему карточка
 * пришла к нему; править — только администратор (§2).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'content_issue.triage')
  return apiData(await listRoutingRules({ tenantId: a.tenantId, actorId: a.userId }))
})
