import { z } from 'zod'
import { requireScope, can } from '../../../../../services/access'
import { transitionPlan } from '../../../../../services/development'
import { apiData, apiError } from '../../../../../utils/apiResponse'
const schema = z.object({ action: z.enum(['submit', 'approve', 'return', 'review', 'close']), comment: z.string().max(2000).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.own')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невірна дія')
  if (['approve', 'return', 'close'].includes(p.data.action) && !can(a, 'development.team')) return apiError(event, 403, 'forbidden', 'Погоджує керівник')
  const r = await transitionPlan({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.action, p.data.comment)
  if (!r.ok) return apiError(event, r.code === 'not_found' ? 404 : 409, r.code, r.code === 'not_found' ? 'План не знайдено' : 'Перехід неможливий із поточного статусу')
  return apiData(r)
})
