import { requireScope } from '../../../../services/access'
import { createRoutingRule } from '../../../../services/contentIssueRouting'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { routingRuleSchema } from '../../../../../shared/schemas/contentIssues'

/**
 * POST /settings/content-issue-routing-rules — новое правило (docs/v2/36 §6.3). Непустой набор
 * правил обязан иметь ровно одно активное запасное правило: первым заводится оно (400
 * `content_issue.fallback_rule_required`). Править маршрутизацию — только администратору (§2).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'content_issue.assign')
  const p = routingRuleSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля правила')
  const r = await createRoutingRule({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (r.ok) return apiData(r.rule)
  if (r.code === 'fallback_rule_required') return apiError(event, 400, 'content_issue.fallback_rule_required', 'Має бути одне запасне правило — створіть його першим')
  return apiError(event, 404, 'not_found', 'Людину, роль або категорію не знайдено')
})
