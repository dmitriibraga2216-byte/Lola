import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { grade } from '../../../../../services/workshops'
import { apiData, apiError } from '../../../../../utils/apiResponse'
const schema = z.object({ decision: z.enum(['accepted', 'rejected', 'rework']), criteriaResults: z.array(z.object({ criterionId: z.string(), passed: z.boolean(), comment: z.string().max(500).optional() })), comment: z.string().max(2000).optional(), score: z.number().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.grade')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте рішення', { issues: p.error.issues })
  const r = await grade({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    const map: Record<string, [number, string]> = { not_found: [404, 'Роботу не знайдено'], not_claimed: [409, 'Спочатку візьміть роботу в перевірку'], comment_required: [422, 'Поясніть, що саме треба виправити — людина побачить цей текст'], rework_exhausted: [422, 'Ліміт доопрацювань вичерпано'], criteria_not_met: [422, 'Не всі критерії виконані — «Зараховано» недоступне'] }
    const [status, msg] = map[r.code]!
    return apiError(event, status, `workshop.${r.code}`, msg)
  }
  return apiData(r)
})
