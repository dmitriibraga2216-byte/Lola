import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { upsertCategory } from '../../../services/developmentExtra'
import { apiData, apiError } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'competency.manage')
  const p = z.object({ id: z.string().uuid().optional(), name: z.string().min(1).max(120), sort: z.number().int().optional() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть назву')
  const r = await upsertCategory({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Категорію не знайдено')
  return apiData(r)
})
