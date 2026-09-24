import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { updateRoutingRule } from '../../../../services/contentIssueRouting'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { routingRulePatchSchema } from '../../../../../shared/schemas/contentIssues'

/** PATCH /settings/content-issue-routing-rules/:id — правка правила (docs/v2/36 §6.3). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'content_issue.assign')
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) return apiError(event, 404, 'not_found', 'Правило не знайдено')
  const p = routingRulePatchSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля правила')
  const r = await updateRoutingRule({ tenantId: a.tenantId, actorId: a.userId }, id.data, p.data)
  if (r.ok) return apiData(r.rule)
  if (r.code === 'fallback_rule_required') return apiError(event, 400, 'content_issue.fallback_rule_required', 'Має бути одне активне запасне правило')
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Правило не знайдено')
  return apiError(event, 404, 'not_found', 'Людину, роль або категорію не знайдено')
})
