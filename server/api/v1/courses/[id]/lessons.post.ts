import { lessonCreateSchema } from '../../../../../shared/schemas/content'
import { requireScope } from '../../../../services/access'
import { addLesson } from '../../../../services/courses'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'course.edit')
  const parsed = lessonCreateSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    return apiError(event, 400, 'validation_failed', 'Перевірте поля уроку', { issues: parsed.error.issues })
  }
  const result = await addLesson({ tenantId: access.tenantId, actorId: access.userId }, parsed.data)
  if (!result.ok) {
    // Раздел обязателен (docs/11 §14.1): без раздела элемент плана не создаётся
    if (result.code === 'section_required') return apiError(event, 422, 'course.section_required', 'Спочатку додайте розділ — елементи плану живуть тільки всередині розділу')
    if (result.code === 'resource_not_found') return apiError(event, 404, 'not_found', 'Ресурс не знайдено')
    if (result.code === 'meetup_not_found') return apiError(event, 404, 'not_found', 'Заняття чи вебінар не знайдено')
    return apiError(event, 422, 'resource.not_published', 'Підключити можна лише опублікований ресурс')
  }
  return apiData(result.lesson)
})
