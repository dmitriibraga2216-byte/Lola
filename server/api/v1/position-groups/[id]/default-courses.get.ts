import { requireAnyScope } from '../../../../services/access'
import { getDefaultCourses } from '../../../../services/positionDefaults'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** GET /position-groups/:id/default-courses (docs/04 §4.11, П-24.3, П-24.5): курсы группы должностей. */
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, ['people.view', 'assignment.create', 'candidate.hire'])
  const r = await getDefaultCourses({ tenantId: a.tenantId, actorId: a.userId }, { kind: 'group', id: getRouterParam(event, 'id')! })
  if (!r) return apiError(event, 404, 'not_found', 'Групу посад не знайдено')
  return apiData(r)
})
