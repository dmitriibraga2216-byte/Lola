import { defaultCoursesSchema } from '../../../../../shared/schemas/positions'
import { requireScope } from '../../../../services/access'
import { setDefaultCourses } from '../../../../services/positionDefaults'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * PUT /position-groups/:id/default-courses (docs/04 §4.11, П-24.3, П-24.5): курсы назначаются не
 * каждой должности отдельно, а группе — «кухня», «зал». Аудитория правила — текущий состав группы.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = defaultCoursesSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте курси і терміни', { issues: p.error.issues })
  const r = await setDefaultCourses({ tenantId: a.tenantId, actorId: a.userId }, { kind: 'group', id: getRouterParam(event, 'id')! }, p.data.items)
  if (!r.ok && r.code === 'not_found') return apiError(event, 404, 'not_found', 'Групу посад не знайдено')
  if (!r.ok) return apiError(event, 422, 'course_not_found', 'Курс не знайдено або його архівовано — оберіть інший', { courseIds: r.courseIds })
  return apiData(r.defaults)
})
