import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { updateTreeGoal } from '../../../../../services/development'
import { apiData, apiError } from '../../../../../utils/apiResponse'

const schema = z.object({ title: z.string().min(3).max(200).optional(), userId: z.string().uuid().optional(), dueAt: z.string().date().nullable().optional(), progressPct: z.number().int().min(0).max(100).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля', { issues: p.error.issues })
  const g = await updateTreeGoal({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!g) return apiError(event, 404, 'not_found', 'Ціль не знайдено')
  return apiData(g)
})
