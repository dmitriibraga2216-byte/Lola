import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { transitionGoal } from '../../../../../services/development'
import { apiData, apiError } from '../../../../../utils/apiResponse'
const schema = z.object({ to: z.string().min(1).max(40), comment: z.string().max(2000).optional(), evaluation: z.string().max(2000).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.own')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть статус')
  const scopes = [...new Set(a.grants.flatMap(g => g.scopes))]
  const r = await transitionGoal({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.to, { comment: p.data.comment, evaluation: p.data.evaluation, scopes })
  if (!r.ok) {
    const map: Record<string, [number, string]> = { not_found: [404, 'Ціль не знайдено'], not_allowed: [409, 'Перехід у цей статус неможливий'], forbidden: [403, 'Цей статус ставить інша роль'], comment_required: [422, 'Потрібен коментар'] }
    const [st, msg] = map[r.code]!
    return apiError(event, st, `goal.${r.code}`, msg)
  }
  return apiData(r)
})
