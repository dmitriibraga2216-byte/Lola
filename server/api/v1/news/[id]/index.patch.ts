import { z } from 'zod'
import { bodySchema } from '../../../../../shared/schemas/content'
import { requireScope } from '../../../../services/access'
import { updateNews } from '../../../../services/news'
import { apiData, apiError } from '../../../../utils/apiResponse'
const schema = z.object({ title: z.string().min(3).max(200).optional(), body: bodySchema.optional(), isPinned: z.boolean().optional(), requiresAck: z.boolean().optional(), status: z.enum(['draft', 'published', 'archived']).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте новину')
  const r = await updateNews({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Новину не знайдено')
  return apiData(r)
})
