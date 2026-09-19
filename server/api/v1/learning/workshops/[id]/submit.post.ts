import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { submitWorkshop } from '../../../../../services/workshops'
import { apiData, apiError } from '../../../../../utils/apiResponse'
const schema = z.object({ text: z.string().max(5000).optional(), files: z.array(z.object({ mediaId: z.string().uuid(), name: z.string(), kind: z.string(), bytes: z.number() })).optional(), enrollmentId: z.string().uuid().optional(), lessonId: z.string().uuid().optional(), device: z.enum(['mobile', 'desktop']).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невірна робота')
  const r = await submitWorkshop({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    if (r.code === 'requirements_not_met') return apiError(event, 422, 'workshop.requirements_not_met', r.reasons?.[0] ?? 'Умови не виконані', { reasons: r.reasons })
    if (r.code === 'already_submitted') return apiError(event, 409, 'workshop.already_submitted', 'Робота вже на перевірці')
    return apiError(event, 404, 'not_found', 'Практикум не знайдено')
  }
  return apiData(r)
})
