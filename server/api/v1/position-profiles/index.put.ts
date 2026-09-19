import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { upsertPositionProfile } from '../../../services/development'
import { apiData, apiError } from '../../../utils/apiResponse'
const schema = z.object({
  positionId: z.string().uuid(), positionLevelId: z.string().uuid().nullable().optional(), description: z.string().max(2000).optional(),
  competencyRequirements: z.array(z.object({ competencyId: z.string().uuid(), requiredLevel: z.number().int().min(1).max(5), isCritical: z.boolean().optional() })).max(30),
  mandatoryContent: z.array(z.object({ subjectType: z.enum(['course']), subjectId: z.string().uuid(), dueDays: z.number().int().min(1).max(365) })).max(30).optional(),
  probationDays: z.number().int().min(1).max(365).nullable().optional(),
})
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'position_profile.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте профіль', { issues: p.error.issues })
  return apiData(await upsertPositionProfile({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
