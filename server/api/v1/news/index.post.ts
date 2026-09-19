import { z } from 'zod'
import { bodySchema } from '../../../../shared/schemas/content'
import { audienceSchema } from '../../../../shared/schemas/assignments'
import { requireScope } from '../../../services/access'
import { createNews } from '../../../services/news'
import { apiData, apiError } from '../../../utils/apiResponse'
const schema = z.object({ title: z.string().min(3).max(200), body: bodySchema.min(1), coverKey: z.string().optional(), isPinned: z.boolean().optional(), requiresAck: z.boolean().optional(), kind: z.enum(['news', 'announcement']).optional(), ackDueAt: z.string().datetime({ offset: true }).nullable().optional(), audience: audienceSchema.nullable().optional(), publish: z.boolean().optional(), lead: z.string().max(300).nullable().optional(), publishAt: z.string().datetime({ offset: true }).nullable().optional(), unpublishAt: z.string().datetime({ offset: true }).nullable().optional(), commentsEnabled: z.boolean().optional(), showMode: z.enum(['modal', 'banner', 'both']).optional(), priority: z.enum(['normal', 'important', 'critical']).optional(), blockUntilAck: z.boolean().optional(), ackText: z.string().max(60).nullable().optional(), categoryId: z.string().uuid().nullable().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте новину', { issues: p.error.issues })
  return apiData(await createNews({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
