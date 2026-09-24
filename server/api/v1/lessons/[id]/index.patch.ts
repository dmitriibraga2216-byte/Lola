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
  const r = await updateLesson(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
    parsed.data,
  )
  if (!r.ok) {
    if (r.code === 'library_reference') {
      // docs/v2/31 §5.4: тело урока-ссылки не редактируется — оно читает закреплённую версию модуля
      return apiError(event, 409, 'lesson.library_reference', 'Це посилання на модуль бібліотеки — відкрийте модуль у бібліотеці або відʼєднайте урок і зробіть копією')
    }
    return apiError(event, 404, 'not_found', 'Урок не знайдено')
  }
  return apiData(r.lesson)
})
