import type { H3Event } from 'h3'
import { apiError } from '../../../../utils/apiResponse'

/** Отказы второго фактора оператора: текст говорит, что делать (docs/25 §7 п. 8). */
export function opsTwoFactorError(event: H3Event, r: { code: string, attemptsLeft?: number }) {
  switch (r.code) {
    case 'invalid': return apiError(event, 422, 'two_factor.invalid', `Невірний код. Залишилось спроб: ${r.attemptsLeft ?? 0}`, { attemptsLeft: r.attemptsLeft ?? 0 })
    case 'blocked': return apiError(event, 429, 'two_factor.blocked', 'Забагато невірних кодів. Вхід заблоковано на 15 хвилин — потім увійдіть знову')
    case 'not_pending': return apiError(event, 409, 'two_factor.not_pending', 'Вхід уже підтверджено — оновіть сторінку')
    case 'not_enrolled': return apiError(event, 409, 'two_factor.not_enrolled', 'Двофакторну автентифікацію ще не налаштовано — налаштуйте її')
    case 'verify_first': return apiError(event, 409, 'two_factor.verify_first', 'Спершу підтвердіть вхід кодом із застосунку')
    case 'code_required': return apiError(event, 422, 'two_factor.code_required', 'Введіть поточний код із застосунку, щоб замінити пристрій')
    case 'no_pending': return apiError(event, 409, 'two_factor.no_pending', 'Почніть налаштування заново: отримайте новий ключ')
    case 'setup_expired': return apiError(event, 409, 'two_factor.setup_expired', 'Ключ застарів (15 хвилин). Отримайте новий і відскануйте ще раз')
    default: return apiError(event, 400, r.code, 'Не вдалося — спробуйте ще раз')
  }
}
