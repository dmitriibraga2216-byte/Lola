import { requireScope } from '../../../services/access'
import { upsertPositionProfile } from '../../../services/development'
import { positionProfileUpsertSchema } from '../../../../shared/schemas/development'
import { apiData, apiError } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'position_profile.manage')
  const p = positionProfileUpsertSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте профіль', { issues: p.error.issues })
  const r = await upsertPositionProfile({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  // docs/33 D-031: посада вже в іншому профілі — вимоги до людини не мають двоїтися
  if (!r.ok) return apiError(event, 409, 'position_taken', 'Ця посада вже входить до іншого профілю — приберіть її там або оберіть іншу', { positionId: r.positionId })
  return apiData({ ...r.profile, positionIds: r.positionIds })
})
