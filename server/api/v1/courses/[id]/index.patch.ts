import { courseUpdateSchema } from '../../../../../shared/schemas/content'
import { requireScope } from '../../../../services/access'
import { updateCourse } from '../../../../services/courses'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'course.edit')
  const parsed = courseUpdateSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    return apiError(event, 400, 'validation_failed', 'Перевірте поля', { issues: parsed.error.issues })
  }
  const course = await updateCourse(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
    parsed.data,
  )
  if (!course) return apiError(event, 404, 'not_found', 'Курс не знайдено')
  return apiData(course)
})
