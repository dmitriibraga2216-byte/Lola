import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { createCompetency } from '../../../services/development'
import { apiData, apiError } from '../../../utils/apiResponse'
export const competencySchema = z.object({
  name: z.string().min(2).max(200), kind: z.enum(['hard', 'soft', 'managerial']).default('hard'), description: z.string().max(2000).optional(), categoryId: z.string().uuid().optional(),
  levels: z.array(z.object({ level: z.number().int().min(1).max(5), title: z.string().min(1).max(60), behavior: z.string().min(3).max(1000) })).min(3).max(5),
  linkedCourses: z.array(z.string().uuid()).optional(), linkedKnowledge: z.array(z.string().uuid()).optional(),
})
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'competency.manage')
  const p = competencySchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте компетенцію', { issues: p.error.issues })
  return apiData(await createCompetency({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
