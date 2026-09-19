import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { updateGoalProgress } from '../../../../../services/development'
import { apiData, apiError } from '../../../../../utils/apiResponse'
const schema = z.object({ progressPct: z.number().int().min(0).max(100).optional(), result: z.string().max(2000).optional(), description: z.string().max(2000).optional(), metric: z.string().max(300).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.own')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля')
  const g = await updateGoalProgress({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!g) return apiError(event, 404, 'not_found', 'Ціль не знайдено або не ваша')
  return apiData(g)
})
