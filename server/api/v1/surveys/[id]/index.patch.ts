import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { updateSurvey } from '../../../../services/surveys'
import { apiData, apiError } from '../../../../utils/apiResponse'
const schema = z.object({ title: z.string().min(3).max(200).optional(), status: z.enum(['draft', 'active', 'closed']).optional(), closesAt: z.string().datetime().nullable().optional(), triggerCourseId: z.string().uuid().nullable().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'survey.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля')
  const r = await updateSurvey({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Опитування не знайдено')
  return apiData(r)
})
