import { z } from 'zod'
import { bodySchema } from '../../../../../shared/schemas/content'
import { requireScope } from '../../../../services/access'
import { updateArticle } from '../../../../services/knowledge'
import { apiData, apiError } from '../../../../utils/apiResponse'
const schema = z.object({ title: z.string().min(3).max(200).optional(), summary: z.string().max(300).optional(), body: bodySchema.optional(), categoryId: z.string().uuid().nullable().optional(), tags: z.array(z.string().max(50)).optional(), status: z.enum(['draft', 'published', 'archived']).optional(), comment: z.string().max(300).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте статтю', { issues: p.error.issues })
  const r = await updateArticle({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Статтю не знайдено')
  return apiData(r)
})
