import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { upsertForm } from '../../../../services/assessment'
import { apiData, apiError } from '../../../../utils/apiResponse'
const schema = z.object({ id: z.string().uuid().optional(), title: z.string().min(3).max(200), description: z.string().max(1000).optional(), groupIds: z.array(z.string().uuid()).min(1).max(30), isActive: z.boolean().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Анкета: назва і хоча б одна група', { issues: p.error.issues })
  const r = await upsertForm({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Анкету не знайдено')
  return apiData(r)
})
