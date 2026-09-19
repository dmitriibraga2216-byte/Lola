import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { upsertEdge } from '../../../../../services/programs'
import { apiData, apiError } from '../../../../../utils/apiResponse'
const schema = z.object({ fromNodeId: z.string().uuid(), toNodeId: z.string().uuid(), sort: z.number().int().optional(), condition: z.union([z.object({ type: z.literal('always') }), z.object({ type: z.literal('passed') }), z.object({ type: z.literal('failed') }), z.object({ type: z.literal('score_gte'), value: z.number().min(0).max(100) }), z.object({ type: z.literal('position_is'), ids: z.array(z.string().uuid()).min(1) })]).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте звʼязок', { issues: p.error.issues })
  const r = await upsertEdge({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 422, 'validation_failed', 'Звʼязок блоку із самим собою неможливий')
  return apiData(r)
})
