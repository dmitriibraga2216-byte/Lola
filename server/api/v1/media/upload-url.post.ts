import { uploadUrlSchema } from '../../../../shared/schemas/content'
import { requireScope } from '../../../services/access'
import { createUploadUrl } from '../../../services/media'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * Единственный вход загрузки (решение docs/v2/44 В-17): `origin` обязателен и проверяется
 * здесь же — `400 origin_required` (docs/v2/34 §7.1). Отдельный код ошибки, а не общий
 * `validation_failed`: клиенту нужно понять, что не хватает именно классификации файла.
 */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'media.upload')
  const body = await readBody(event)
  const parsed = uploadUrlSchema.safeParse(body)
  if (!parsed.success) {
    if (parsed.error.issues.some(i => i.path[0] === 'origin')) {
      return apiError(event, 400, 'origin_required', 'Не вказано походження файлу')
    }
    return apiError(event, 400, 'validation_failed', 'Перевірте файл')
  }
  const result = await createUploadUrl({ tenantId: access.tenantId, actorId: access.userId }, parsed.data)
  if (!result.ok) return apiError(event, 400, `media.${result.code}`, result.message)
  return apiData(result)
})
