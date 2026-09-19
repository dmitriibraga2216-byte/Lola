import { z } from 'zod'
import { bodySchema } from '../../../../shared/schemas/content'
import { requireScope } from '../../../services/access'
import { createArticle } from '../../../services/knowledge'
import { apiData, apiError } from '../../../utils/apiResponse'
const schema = z.object({ title: z.string().min(3).max(200), summary: z.string().max(300).optional(), body: bodySchema.min(1), categoryId: z.string().uuid().optional(), tags: z.array(z.string().max(50)).max(20).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте статтю', { issues: p.error.issues })
  return apiData(await createArticle({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
