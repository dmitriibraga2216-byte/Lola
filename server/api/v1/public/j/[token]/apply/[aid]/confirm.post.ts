import { publicApplyConfirmSchema } from '../../../../../../../../shared/schemas/publicApply'
import { confirmApplication } from '../../../../../../../services/publicApply'
import { hitRateLimit } from '../../../../../../../services/rateLimit'
import { apiData, apiError } from '../../../../../../../utils/apiResponse'
import { clientIp } from '../../../../../../../utils/authCookies'

/**
 * POST /api/v1/public/j/:token/apply/:aid/confirm — подтверждение контакта кодом
 * (docs/v2/29 §7.5, §10).
 *
 * Успех отвечает `accepted` и когда кандидат создан, и когда отклик остался на модерации:
 * различие снаружи снова сделало бы форму отладчиком (§7.3). Неверный код — честный `400`:
 * он про ввод человека, а не про сработавшую проверку.
 *
 * Потолок запросов (правило контура В-9 п. 2в) — поверх пяти попыток ввода самого кода
 * (§7.5): попытки считаются на контакт, а этот счётчик — на адрес, и он не даёт перебирать
 * коды, меняя отклики.
 */
const TRY_LIMIT = 30
const TRY_WINDOW_SEC = 3600

export default defineEventHandler(async (event) => {
  if (!await hitRateLimit(`apply:confirm:${clientIp(event)}`, TRY_LIMIT, TRY_WINDOW_SEC)) {
    setResponseHeader(event, 'Retry-After', TRY_WINDOW_SEC)
    return apiError(event, 429, 'otp.too_many', 'Забагато спроб. Спробуйте пізніше')
  }
  const p = publicApplyConfirmSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'otp.invalid', 'Код — шість цифр')
  const r = await confirmApplication(
    getRouterParam(event, 'token')!,
    getRouterParam(event, 'aid')!,
    p.data.code,
    { ip: clientIp(event), userAgent: getHeader(event, 'user-agent') },
  )
  if (r.ok) return apiData({ status: r.status })
  switch (r.code) {
    case 'otp_too_many':
      return apiError(event, 429, 'otp.too_many', 'Забагато спроб. Спробуйте пізніше')
    case 'otp_invalid':
      return apiError(event, 400, 'otp.invalid', 'Невірний код')
    case 'expired':
      return apiError(event, 410, 'application.expired', 'Термін підтвердження минув. Надішліть відгук ще раз')
    case 'gone':
      return apiError(event, 410, 'vacancy.paused', 'Набір за цією вакансією призупинено')
    default:
      return apiError(event, 404, 'vacancy.not_found', 'Посилання не знайдено')
  }
})
