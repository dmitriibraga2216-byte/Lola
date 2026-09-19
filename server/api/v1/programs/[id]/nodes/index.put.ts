import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { reorderNodes, upsertNode } from '../../../../../services/programs'
import { apiData, apiError } from '../../../../../utils/apiResponse'
const schema = z.union([
  z.object({ reorder: z.array(z.string().uuid()).min(1) }),
  z.object({ id: z.string().uuid().optional(), itemType: z.enum(['course', 'resource', 'quiz', 'workshop', 'survey', 'meetup', 'webinar']), itemId: z.string().uuid(), titleOverride: z.string().max(200).nullable().optional(), sort: z.number().int().optional(), position: z.object({ x: z.number(), y: z.number() }).optional(), isRequired: z.boolean().optional(), dueDays: z.number().int().min(1).max(365).nullable().optional(), unlockAfter: z.array(z.string().uuid()).optional(), unlockRule: z.union([z.object({ type: z.literal('all') }), z.object({ type: z.literal('any') }), z.object({ type: z.literal('score'), min: z.number().min(0).max(100) })]).optional() }),
])
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте елемент', { issues: p.error.issues })
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const id = getRouterParam(event, 'id')!
  if ('reorder' in p.data) return apiData({ ok: await reorderNodes(ctx, id, p.data.reorder) })
  const r = await upsertNode(ctx, id, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Елемент не знайдено')
  return apiData(r)
})
