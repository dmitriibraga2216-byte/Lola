import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { upsertGoalStatus } from '../../../services/development'
import { apiData, apiError } from '../../../utils/apiResponse'
const schema = z.object({ code: z.string().regex(/^[a-z_]{2,40}$/), name: z.string().min(1).max(60), color: z.enum(['sun', 'teal', 'coral', 'muted']), sort: z.number().int().min(0).max(99), isInitial: z.boolean().optional(), isFinal: z.boolean().optional(), isSuccess: z.boolean().optional(), requiresComment: z.boolean().optional(), allowedTransitions: z.array(z.string()).max(10), whoCanSet: z.array(z.enum(['development.own', 'development.team', 'development.manage'])).min(1) })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте статус', { issues: p.error.issues })
  return apiData(await upsertGoalStatus({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
