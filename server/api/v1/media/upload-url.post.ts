import { uploadUrlSchema } from '../../../../shared/schemas/content'
import { requireAccess, requireScope } from '../../../services/access'
import { createUploadUrl, SELF_SERVICE_ORIGINS } from '../../../services/media'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * Единственный вход загрузки (решение docs/v2/44 В-17): `origin` обязателен и проверяется
 * здесь же — `400 origin_required` (docs/v2/34 §7.1). Отдельный код ошибки, а не общий
 * `validation_failed`: клиенту нужно понять, что не хватает именно классификации файла.
 *
 * Право — `media.upload`, кроме происхождений, которые человек грузит **себе сам**
 * (`SELF_SERVICE_ORIGINS`): свой документ типа `self_upload` загружает и сотрудник без
 * `media.upload` (docs/v2/38 §2). Файл при этом ничей, пока его не привяжет документ, —
 * а привязку проверяет уже `POST /people/:id/documents`.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const selfService = SELF_SERVICE_ORIGINS.includes((body as { origin?: string } | undefined)?.origin as never)
  const access = selfService ? await requireAccess(event) : await requireScope(event, 'media.upload')
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
