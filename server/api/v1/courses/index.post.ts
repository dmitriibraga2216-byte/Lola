import { courseCreateSchema } from '../../../../shared/schemas/content'
import { requireScope } from '../../../services/access'
import { createCourse } from '../../../services/courses'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'course.create')
  const parsed = courseCreateSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    return apiError(event, 400, 'validation_failed', 'Перевірте поля', { issues: parsed.error.issues })
  }
  try {
    return apiData(await createCourse({ tenantId: access.tenantId, actorId: access.userId }, parsed.data))
  }
  catch (err) {
    if (String(err).includes('courses_tenant_id_slug_unique')) {
      return apiError(event, 409, 'conflict', 'Курс з таким slug вже існує')
    }
    throw err
  }
})
