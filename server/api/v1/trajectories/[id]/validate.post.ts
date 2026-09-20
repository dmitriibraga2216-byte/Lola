import { requireScope } from '../../../../services/access'
import { validateTrajectory } from '../../../../services/trajectories'
import { withTenant } from '../../../../utils/withTenant'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** «Перевірити» (docs/04 §4.10): недостижимые блоки, пути к Finish, циклы, обязательные поля. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.manage')
  const problems = await withTenant(a.tenantId, a.userId, tx => validateTrajectory(tx, getRouterParam(event, 'id')!))
  if (!problems) return apiError(event, 404, 'not_found', 'Траєкторію не знайдено')
  return apiData({ ok: problems.length === 0, problems })
})
