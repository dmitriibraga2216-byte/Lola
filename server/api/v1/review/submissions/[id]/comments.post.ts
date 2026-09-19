import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { addComment } from '../../../../../services/workshops'
import { apiData, apiError } from '../../../../../utils/apiResponse'
const schema = z.object({ body: z.string().min(1).max(2000), isInternal: z.boolean().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Порожній коментар')
  const r = await addComment({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.body, p.data.isInternal)
  if (!r) return apiError(event, 404, 'not_found', 'Роботу не знайдено')
  return apiData(r)
})
