import { uploadApplicationResume } from '../../../../../../../services/publicApply'
import { hitRateLimit } from '../../../../../../../services/rateLimit'
import { apiData, apiError } from '../../../../../../../utils/apiResponse'
import { clientIp } from '../../../../../../../utils/authCookies'

/**
 * POST /api/v1/public/j/:token/apply/:aid/resume — резюме из публичного контура
 * (docs/v2/29 §6.3, §10, план PR-17, отложено из PR-16).
 *
 * Multipart, поле `file`: PDF, DOC, DOCX або зображення, до 10 МБ. Принимается только после
 * подтверждения контакта кодом (`uploadApplicationResume()` — там же обоснование).
 *
 * Потолок запросов (правило контура В-9 п. 2в) — как у остальных ручек контура.
 */
const FLOOD_LIMIT = 20
const FLOOD_WINDOW_SEC = 3600

export default defineEventHandler(async (event) => {
  if (!await hitRateLimit(`apply:resume:${clientIp(event)}`, FLOOD_LIMIT, FLOOD_WINDOW_SEC)) {
    setResponseHeader(event, 'Retry-After', FLOOD_WINDOW_SEC)
    return apiError(event, 429, 'rate.too_many', 'Забагато запитів. Спробуйте пізніше')
  }

  const parts = await readMultipartFormData(event)
  const file = parts?.find(p => p.name === 'file' && p.data && p.filename)
  if (!file || !file.filename) return apiError(event, 422, 'validation_failed', 'Додайте файл резюме')

  const r = await uploadApplicationResume(
    getRouterParam(event, 'token')!,
    getRouterParam(event, 'aid')!,
    { filename: file.filename, mime: file.type ?? 'application/octet-stream', data: file.data },
  )
  if (r.ok) return apiData({ assetId: r.assetId })
  switch (r.code) {
    case 'mime_not_allowed':
      return apiError(event, 415, 'file.type', 'Формат не підтримується')
    case 'too_big':
      return apiError(event, 413, 'media.too_big', 'Файл завеликий. Максимум 10 МБ')
    case 'storage_limit':
      return apiError(event, 413, 'media.too_big', 'Немає місця для файлу. Спробуйте пізніше')
    case 'state_locked':
      return apiError(event, 409, 'application.not_confirmed', 'Спершу підтвердіть контакт кодом')
    case 'gone':
      return apiError(event, 410, 'vacancy.paused', 'Набір за цією вакансією призупинено')
    default:
      return apiError(event, 404, 'vacancy.not_found', 'Посилання не знайдено')
  }
})
