import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { approveGoal } from '../../../../../services/development'
import { apiData, apiError } from '../../../../../utils/apiResponse'
/** «Погодити» / «Повернути» цель (docs/19 §5.3, §7.4). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.team')
  const p = z.object({ decision: z.enum(['approve', 'return']), comment: z.string().max(2000).optional() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть рішення')
  const r = await approveGoal({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.decision, p.data.comment)
  if (!r.ok) return apiError(event, r.code === 'not_found' ? 404 : r.code === 'self' ? 403 : 422, `goal.${r.code}`, r.code === 'self' ? 'Власну ціль не погоджують' : r.code === 'comment_required' ? 'Поясніть, що доопрацювати' : 'Ціль не знайдено')
  return apiData(r)
})
