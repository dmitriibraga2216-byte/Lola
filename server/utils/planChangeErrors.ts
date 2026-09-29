import type { H3Event } from 'h3'
import { apiError } from './apiResponse'

/** Отказы смены тарифа владельцем (docs/v2/35 §7.6, §10, §12) — один текст на код во всех ручках. */
export function planChangeError(event: H3Event, code: 'not_found' | 'upgrade_manual' | 'same_plan' | 'conflict' | 'not_applicable' | 'limit_exceeded') {
  switch (code) {
    case 'not_found':
      return apiError(event, 404, 'not_found', 'Тариф або заявку не знайдено')
    case 'upgrade_manual':
      return apiError(event, 422, 'plan_change.upgrade_manual', 'Перехід на вищий тариф підключає менеджер Lola після оплати — зверніться до нього')
    case 'same_plan':
      return apiError(event, 422, 'plan_change.same_plan', 'Цей тариф уже підключено')
    case 'conflict':
      return apiError(event, 409, 'conflict', 'Перехід на інший тариф уже заплановано. Скасуйте його, щоб обрати новий')
    case 'not_applicable':
      return apiError(event, 409, 'conflict', 'Заявку вже застосовано або скасовано')
    default:
      return apiError(event, 409, 'limit_exceeded', 'Щоб перейти на цей тариф, зменшіть використання до нових лімітів')
  }
}
