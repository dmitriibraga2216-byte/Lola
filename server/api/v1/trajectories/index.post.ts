import { trajectoryCreateSchema } from '../../../../shared/schemas/trajectories'
import { requireScope } from '../../../services/access'
import { createTrajectory } from '../../../services/trajectories'
import { apiData, apiError } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.manage')
  const p = trajectoryCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте траєкторію', { issues: p.error.issues })
  return apiData(await createTrajectory({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
