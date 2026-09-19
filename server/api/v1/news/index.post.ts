import { z } from 'zod'
import { bodySchema } from '../../../../shared/schemas/content'
import { audienceSchema } from '../../../../shared/schemas/assignments'
import { requireScope } from '../../../services/access'
import { createNews } from '../../../services/news'
import { apiData, apiError } from '../../../utils/apiResponse'
const schema = z.object({ title: z.string().min(3).max(200), body: bodySchema.min(1), coverKey: z.string().optional(), isPinned: z.boolean().optional(), requiresAck: z.boolean().optional(), audience: audienceSchema.nullable().optional(), publish: z.boolean().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте новину', { issues: p.error.issues })
  return apiData(await createNews({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
