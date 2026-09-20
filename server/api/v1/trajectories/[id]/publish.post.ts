import { requireScope } from '../../../../services/access'
import { publishTrajectory } from '../../../../services/trajectories'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.publish')
  const r = await publishTrajectory({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Траєкторію не знайдено')
    if (r.code === 'rule_required') return apiError(event, 422, 'trajectory.rule_required', 'Для режиму «Застосувати правило автоматизації» оберіть правило')
    return apiError(event, 422, 'trajectory.invalid', r.problems[0]?.message ?? 'Траєкторію не можна опублікувати', { problems: r.problems })
  }
  return apiData(r)
})
