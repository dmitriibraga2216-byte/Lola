import { answerFileSchema } from '../../../../../../../shared/schemas/quizzes'
import { requireScope } from '../../../../../../services/access'
import { addAnswerFile } from '../../../../../../services/attempts'
import { apiData, apiError } from '../../../../../../utils/apiResponse'

/** Вложение к свободному ответу (docs/04 §4.6): файл загружен через /media, здесь — привязка к ответу. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.attempt')
  const p = answerFileSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Спочатку завантажте файл')
  const r = await addAnswerFile({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, getRouterParam(event, 'questionId')!, p.data)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Спробу або питання не знайдено')
    if (r.code === 'media_not_found') return apiError(event, 404, 'not_found', 'Файл не знайдено')
    if (r.code === 'locked') return apiError(event, 423, 'attempt.locked', 'Спробу вже надіслано')
    if (r.code === 'too_many') return apiError(event, 422, 'attempt.too_many_files', 'Не більше 5 файлів до відповіді')
    return apiError(event, 422, 'attempt.files_not_allowed', 'До цього питання файли не прикріплюються')
  }
  return apiData(r)
})
