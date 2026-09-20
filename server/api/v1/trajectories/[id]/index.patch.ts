import { trajectoryUpdateSchema } from '../../../../../shared/schemas/trajectories'
import { requireScope, can } from '../../../../services/access'
import { updateTrajectory } from '../../../../services/trajectories'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.manage')
  const p = trajectoryUpdateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте траєкторію', { issues: p.error.issues })
  // Привязка правила автоматизации — только admin (docs/17 §2)
  if ((p.data.automationRuleId !== undefined || p.data.assignMode === 'automation') && !can(a, 'program.link_rule')) return apiError(event, 403, 'forbidden', 'Привʼязувати правило автоматизації може лише адміністратор')
  const r = await updateTrajectory({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Траєкторію не знайдено')
    if (r.code === 'rule_not_found') return apiError(event, 422, 'trajectory.rule_not_found', 'Правило автоматизації не знайдено — оберіть інше')
    return apiError(event, 422, 'trajectory.rule_required', 'Для режиму «Застосувати правило автоматизації» оберіть правило')
  }
  return apiData(r.trajectory)
})
