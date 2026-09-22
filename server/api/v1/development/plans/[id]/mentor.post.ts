import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { setPlanMentor } from '../../../../../services/development'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** Наставник ІПР (docs/19 §3.4, мокап DevelopmentPlanMobile, screens-7) — призначає керівник. */
const schema = z.object({ mentorId: z.string().uuid().nullable() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.team')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть наставника', { issues: p.error.issues })
  const r = await setPlanMentor({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.mentorId)
  if (!r) return apiError(event, 404, 'not_found', 'План не знайдено')
  return apiData(r)
})
