import { assignmentCompetenciesSchema } from '../../../../../shared/schemas/assignments'
import { requireScope } from '../../../../services/access'
import { setCompetencies } from '../../../../services/tasks'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** «Обрати компетенції» (Г-15.3). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = assignmentCompetenciesSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте список компетенцій', { issues: p.error.issues })
  const r = await setCompetencies({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.competencyIds)
  if (!r) return apiError(event, 404, 'not_found', 'Призначення не знайдено')
  return apiData({ competencyIds: r })
})
