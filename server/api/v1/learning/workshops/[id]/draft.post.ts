import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { saveDraft } from '../../../../../services/workshops'
import { apiData, apiError } from '../../../../../utils/apiResponse'
const schema = z.object({ text: z.string().max(5000).optional(), files: z.array(z.object({ mediaId: z.string().uuid(), name: z.string(), kind: z.string(), bytes: z.number() })).optional(), enrollmentId: z.string().uuid().optional(), lessonId: z.string().uuid().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невірна чернетка')
  const r = await saveDraft({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Практикум не знайдено')
  return apiData(r)
})
