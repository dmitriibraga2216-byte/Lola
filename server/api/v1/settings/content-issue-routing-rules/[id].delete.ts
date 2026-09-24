import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { deleteRoutingRule } from '../../../../services/contentIssueRouting'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** DELETE /settings/content-issue-routing-rules/:id — запасное правило удаляется последним (§6.3). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'content_issue.assign')
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) return apiError(event, 404, 'not_found', 'Правило не знайдено')
  const r = await deleteRoutingRule({ tenantId: a.tenantId, actorId: a.userId }, id.data)
  if (r.ok) return apiData({ ok: true })
  if (r.code === 'fallback_rule_required') return apiError(event, 400, 'content_issue.fallback_rule_required', 'Запасне правило видаляється останнім — спершу приберіть інші правила')
  return apiError(event, 404, 'not_found', 'Правило не знайдено')
})
