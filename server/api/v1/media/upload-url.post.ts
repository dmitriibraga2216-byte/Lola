import { uploadUrlSchema } from '../../../../shared/schemas/content'
import { requireAccess, requireAnyScope, requireScope } from '../../../services/access'
import { createUploadUrl, LEARNER_UPLOAD_ORIGINS, SELF_SERVICE_ORIGINS } from '../../../services/media'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * Единственный вход загрузки (решение docs/v2/44 В-17): `origin` обязателен и проверяется
 * здесь же — `400 origin_required` (docs/v2/34 §7.1). Отдельный код ошибки, а не общий
 * `validation_failed`: клиенту нужно понять, что не хватает именно классификации файла.
 *
 * Право — `media.upload`, кроме двух случаев:
 *  - происхождения, которые человек грузит **себе сам** (`SELF_SERVICE_ORIGINS`): свой документ
 *    типа `self_upload` загружает и сотрудник без `media.upload` (docs/v2/38 §2). Файл при этом
 *    ничей, пока его не привяжет документ, — привязку проверяет `POST /people/:id/documents`;
 *  - собственная работа учащегося (`LEARNER_UPLOAD_ORIGINS`: сдача практикума, видеоответ,
 *    скриншот жалобы) — достаточно `learn.attempt` (docs/v2/34 §7.5, §13 к. 1).
 *
 * Исчерпанная квота с `clientRef` — не отказ, а **`202 {deferred: true, pendingId}`**
 * (docs/v2/34 §7.5, `41` §5.7): запись остаётся на устройстве и досылается тем же запросом,
 * когда появится место. Без `clientRef` — прежний `400 media.storage_limit`.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const origin = (body as { origin?: string } | undefined)?.origin as never
  const access = SELF_SERVICE_ORIGINS.includes(origin)
    ? await requireAccess(event)
    : LEARNER_UPLOAD_ORIGINS.includes(origin)
      ? await requireAnyScope(event, ['media.upload', 'learn.attempt'])
      : await requireScope(event, 'media.upload')
  const parsed = uploadUrlSchema.safeParse(body)
  if (!parsed.success) {
    if (parsed.error.issues.some(i => i.path[0] === 'origin')) {
      return apiError(event, 400, 'origin_required', 'Не вказано походження файлу')
    }
    return apiError(event, 400, 'validation_failed', 'Перевірте файл')
  }
  const result = await createUploadUrl({ tenantId: access.tenantId, actorId: access.userId }, parsed.data)
  if (!result.ok) {
    if (result.code === 'deferred') {
      setResponseStatus(event, 202)
      return apiData({ deferred: true, pendingId: result.pendingId, expiresAt: result.expiresAt, message: result.message })
    }
    if (result.code === 'pending_done') return apiError(event, 409, 'pending_upload_done', result.message)
    if (result.code === 'pending_abandoned') return apiError(event, 410, 'pending_upload_abandoned', result.message)
    return apiError(event, 400, `media.${result.code}`, result.message)
  }
  return apiData(result)
})
