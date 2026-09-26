import type { H3Event } from 'h3'
import type { PlatformSession } from '../services/platform'
import { apiError } from './apiResponse'
import { platformCan, type PlatformAction } from '../../shared/domain/platformRoles'

/**
 * Сессия оператора, в том числе промежуточная (пароль принят, второй фактор — нет). Только для
 * экрана второго фактора, `me` и выхода; всё остальное — `requirePlatform(event, action)`.
 */
export function requirePlatformSession(event: H3Event): PlatformSession {
  const p = event.context.platform as PlatformSession | null | undefined
  if (!p) throw createError({ statusCode: 401, data: { code: 'auth_required', message: 'Потрібен вхід оператора' } })
  return p
}

/**
 * Консоль оператора (docs/03 §3.12, docs/25 §7 п. 2, 7–8): полная сессия (второй фактор пройден)
 * и право роли на действие — одна функция `platformCan()`, как `can()` у тенанта. Каждая ручка
 * `/api/v1/platform/*` зовёт это с явным действием; интерфейс кнопки только прячет.
 */
export function requirePlatform(event: H3Event, action: PlatformAction): PlatformSession {
  const p = requirePlatformSession(event)
  if (p.twoFactorPending) {
    throw createError({ statusCode: 401, data: { code: 'two_factor_required', message: p.twoFactorEnrolled ? 'Підтвердіть вхід кодом із застосунку-автентифікатора' : 'Налаштуйте двофакторну автентифікацію — без неї консоль недоступна' } })
  }
  if (!platformCan(p.role, action)) {
    throw createError({ statusCode: 403, data: { code: 'platform.forbidden', message: 'Вашій ролі оператора ця дія недоступна. Зверніться до власника платформи', details: { action, role: p.role } } })
  }
  return p
}

/** Ошибки действий над тенантом (docs/25 §8): 404 — не найден, 409 — не тот статус или не совпал slug подтверждения. */
export function tenantActionError(event: H3Event, code: 'not_found' | 'wrong_status' | 'confirm_mismatch') {
  if (code === 'not_found') return apiError(event, 404, 'not_found', 'Тенант не знайдено')
  if (code === 'confirm_mismatch') return apiError(event, 409, 'tenant.confirm_mismatch', 'Slug не збігається — введіть slug простору точно')
  return apiError(event, 409, 'tenant.wrong_status', 'Дія недоступна в поточному стані простору: призупинити можна активний, видалити — призупинений, скасувати видалення — той, що чекає видалення')
}
