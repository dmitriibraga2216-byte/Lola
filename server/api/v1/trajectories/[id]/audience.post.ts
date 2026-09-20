import { trajectoryAssignSchema } from '../../../../../shared/schemas/trajectories'
import { requireScope } from '../../../../services/access'
import { assignTrajectory } from '../../../../services/trajectories'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** Ручное назначение списком людей (docs/04 §4.10 POST /trajectories/:id/audience). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = trajectoryAssignSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Оберіть людей', { issues: p.error.issues })
  const r = await assignTrajectory({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.userIds)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Траєкторію не знайдено')
    return apiError(event, 422, 'trajectory.not_published', 'Спершу опублікуйте траєкторію')
  }
  return apiData(r)
})
