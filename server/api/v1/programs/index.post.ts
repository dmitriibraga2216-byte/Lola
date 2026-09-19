import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { createProgram } from '../../../services/programs'
import { apiData, apiError } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.manage')
  const p = z.object({ title: z.string().min(3, 'Назва від 3 символів').max(200), description: z.string().max(2000).optional(), mode: z.enum(['linear', 'graph']).optional(), tags: z.array(z.string()).max(20).optional() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте програму', { issues: p.error.issues })
  return apiData(await createProgram({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
