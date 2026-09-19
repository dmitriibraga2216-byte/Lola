import { z } from 'zod'
import { bodySchema } from '../../../../../shared/schemas/content'
import { requireScope } from '../../../../services/access'
import { updateNews } from '../../../../services/news'
import { apiData, apiError } from '../../../../utils/apiResponse'
const schema = z.object({ title: z.string().min(3).max(200).optional(), body: bodySchema.optional(), isPinned: z.boolean().optional(), requiresAck: z.boolean().optional(), kind: z.enum(['news', 'announcement']).optional(), ackDueAt: z.string().datetime({ offset: true }).nullable().optional(), status: z.enum(['draft', 'published', 'archived']).optional(), coverKey: z.string().nullable().optional(), lead: z.string().max(300).nullable().optional(), publishAt: z.string().datetime({ offset: true }).nullable().optional(), unpublishAt: z.string().datetime({ offset: true }).nullable().optional(), commentsEnabled: z.boolean().optional(), showMode: z.enum(['modal', 'banner', 'both']).optional(), priority: z.enum(['normal', 'important', 'critical']).optional(), blockUntilAck: z.boolean().optional(), ackText: z.string().max(60).nullable().optional(), categoryId: z.string().uuid().nullable().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте новину')
  const r = await updateNews({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Новину не знайдено')
  return apiData(r)
})
