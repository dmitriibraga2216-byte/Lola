import { lessonUpdateSchema } from '../../../../../shared/schemas/content'
import { requireScope } from '../../../../services/access'
import { updateLesson } from '../../../../services/courses'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'course.edit')
  const parsed = lessonUpdateSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    return apiError(event, 400, 'validation_failed', 'Перевірте поля уроку', { issues: parsed.error.issues })
  }
  const lesson = await updateLesson(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
    parsed.data,
  )
  if (!lesson) return apiError(event, 404, 'not_found', 'Урок не знайдено')
  return apiData(lesson)
})
