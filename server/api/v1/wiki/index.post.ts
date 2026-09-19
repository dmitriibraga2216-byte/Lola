import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { createPage } from '../../../services/wiki'
import { blockSchema } from '../../../../shared/schemas/content'
import { apiData, apiError } from '../../../utils/apiResponse'
export const wikiSchema = z.object({ title: z.string().min(2).max(200), body: z.array(blockSchema).max(300), parentId: z.string().uuid().nullable().optional(), viewRoles: z.array(z.string()).max(10).optional(), editRoles: z.array(z.string()).max(10).optional(), status: z.enum(['draft', 'published', 'archived']).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'wiki.edit')
  const p = wikiSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте сторінку', { issues: p.error.issues })
  const r = await createPage({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if ('forbidden' in r) return apiError(event, 403, 'forbidden', 'Немає права редагувати цю гілку')
  return apiData(r)
})
