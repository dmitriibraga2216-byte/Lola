import { requireScope } from '../../../services/access'
import { upsertPositionProfile } from '../../../services/development'
import { positionProfileUpsertSchema } from '../../../../shared/schemas/development'
import { apiData, apiError } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'position_profile.manage')
  const p = positionProfileUpsertSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте профіль', { issues: p.error.issues })
  return apiData(await upsertPositionProfile({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
