import { publicApplySchema } from '../../../../../../shared/schemas/publicApply'
import { submitApplication } from '../../../../../services/publicApply'
import { hitRateLimit } from '../../../../../services/rateLimit'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { clientIp } from '../../../../../utils/authCookies'

/**
 * POST /api/v1/public/j/:token/apply — приём отклика (docs/v2/29 §6.3, §7.3, §10).
 *
 * **Один ответ на все исходы, кроме двух.** `202` уходит и при чистом отклике, и при
 * сработавшем honeypot, и при исчерпанном частотном правиле, и при исчерпанном лимите
 * тарифа: форма никогда не сообщает боту, какая проверка сработала (§7.3, критерии §13
 * к. 3, 4, 5). Исключения ровно два и оба про человека, а не про спам: отсутствие согласия
 * на обработку ПД (§7.23 — это про право) и протухшая форма (её нужно обновить, §7.6).
 *
 * Частотное ограничение стоит **дважды и по-разному**. Здесь, в обработчике, — грубый
 * потолок запросов (правило контура В-9 п. 2в): он защищает от потока и до человека не
 * доходит — тридцать отправок в час с одного адреса живой посетитель не делает. Правила
 * §7.4 («три успешных отклика в час») живут в сервисе и отвечают `202`, потому что они про
 * поведение, а не про нагрузку, и сообщать о них отправителю нельзя.
 */
const FLOOD_LIMIT = 30
const FLOOD_WINDOW_SEC = 3600

export default defineEventHandler(async (event) => {
  if (!await hitRateLimit(`apply:req:${clientIp(event)}`, FLOOD_LIMIT, FLOOD_WINDOW_SEC)) {
    setResponseHeader(event, 'Retry-After', FLOOD_WINDOW_SEC)
    return apiError(event, 429, 'rate.too_many', 'Забагато запитів. Спробуйте пізніше')
  }
  const p = publicApplySchema.safeParse(await readBody(event))
  if (!p.success) {
    const issues = p.error.issues
    if (issues.some(i => i.path[0] === 'consent')) {
      return apiError(event, 422, 'consent.required', 'Без згоди на обробку даних відгук надіслати не можна')
    }
    if (issues.some(i => i.path[0] === 'phone' && i.message === 'contact_required')) {
      return apiError(event, 422, 'contact.required', 'Вкажіть телефон або пошту')
    }
    if (issues.some(i => i.path[0] === 'fullName')) {
      return apiError(event, 422, 'validation_failed', 'Вкажіть ім\'я та прізвище')
    }
    return apiError(event, 422, 'validation_failed', 'Перевірте заповнені поля', { issues })
  }

  const r = await submitApplication(getRouterParam(event, 'token')!, p.data, {
    ip: clientIp(event),
    userAgent: getHeader(event, 'user-agent'),
  })
  if (r.ok) {
    setResponseStatus(event, 202)
    return apiData({ applicationId: r.applicationId, otpRequired: r.otpRequired, channel: r.channel })
  }
  switch (r.code) {
    case 'nonce_stale':
      return apiError(event, 422, 'form.stale', 'Форма застаріла. Оновіть сторінку')
    case 'gone':
      return apiError(event, 410, 'vacancy.paused', 'Набір за цією вакансією призупинено')
    case 'consent_required':
      return apiError(event, 422, 'consent.required', 'Без згоди на обробку даних відгук надіслати не можна')
    case 'contact_required':
      return apiError(event, 422, 'contact.required', 'Вкажіть телефон або пошту')
    default:
      return apiError(event, 404, 'vacancy.not_found', 'Посилання не знайдено')
  }
})
