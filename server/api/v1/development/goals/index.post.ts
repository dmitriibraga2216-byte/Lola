import { z } from 'zod'
import { requireScope, can } from '../../../../services/access'
import { createGoal } from '../../../../services/development'
import { apiData, apiError } from '../../../../utils/apiResponse'
const schema = z.object({
  userId: z.string().uuid().optional(), planId: z.string().uuid().optional(), title: z.string().min(3).max(200), description: z.string().max(2000).optional(),
  kind: z.enum(['competency', 'learning', 'result', 'project']).default('learning'), competencyId: z.string().uuid().optional(), targetLevel: z.number().int().min(1).max(5).optional(),
  metric: z.string().max(300).optional(), linkedContent: z.array(z.object({ subjectType: z.string(), subjectId: z.string().uuid() })).optional(), dueAt: z.string().date(), mentorId: z.string().uuid().optional(),
})
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.own')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте ціль', { issues: p.error.issues })
  const userId = p.data.userId ?? a.userId
  if (userId !== a.userId && !can(a, 'development.team')) return apiError(event, 403, 'forbidden', 'Немає доступу')
  return apiData(await createGoal({ tenantId: a.tenantId, actorId: a.userId }, { ...p.data, userId }))
})
