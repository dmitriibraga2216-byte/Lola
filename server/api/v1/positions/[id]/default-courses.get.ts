import { requireAnyScope } from '../../../../services/access'
import { getDefaultCourses } from '../../../../services/positionDefaults'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * GET /positions/:id/default-courses (docs/04 §4.11, docs/v2/39 П-24.3): курсы по умолчанию
 * должности, курсы её группы и итог `effective` — им предзаполняется окно найма (`docs/v2/28`
 * §5.5). Читают справочник людей, назначающий и нанимающий.
 */
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, ['people.view', 'assignment.create', 'candidate.hire'])
  const r = await getDefaultCourses({ tenantId: a.tenantId, actorId: a.userId }, { kind: 'position', id: getRouterParam(event, 'id')! })
  if (!r) return apiError(event, 404, 'not_found', 'Посаду не знайдено')
  return apiData(r)
})
