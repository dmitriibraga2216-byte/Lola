import type { H3Event } from 'h3'
import type { PlatformAuth } from '../services/platform'
import { apiError } from './apiResponse'

/** Панель оператора: только с платформенной сессией (docs/03 §3.12). */
export function requirePlatform(event: H3Event): PlatformAuth {
  const p = event.context.platform as PlatformAuth | null | undefined
  if (!p) throw createError({ statusCode: 401, data: { code: 'auth_required', message: 'Потрібен вхід оператора' } })
  return p
}

/** Ошибки действий над тенантом (docs/25 §8): 404 — не найден, 409 — не тот статус или не совпал slug подтверждения. */
export function tenantActionError(event: H3Event, code: 'not_found' | 'wrong_status' | 'confirm_mismatch') {
  if (code === 'not_found') return apiError(event, 404, 'not_found', 'Тенант не знайдено')
  if (code === 'confirm_mismatch') return apiError(event, 409, 'tenant.confirm_mismatch', 'Slug не збігається — введіть slug простору точно')
  return apiError(event, 409, 'tenant.wrong_status', 'Дія недоступна в поточному стані простору: призупинити можна активний, видалити — призупинений, скасувати видалення — той, що чекає видалення')
}
