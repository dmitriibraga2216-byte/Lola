import type { H3Event } from 'h3'
import type { PlatformAuth } from '../services/platform'

/** Панель оператора: только с платформенной сессией (docs/03 §3.12). */
export function requirePlatform(event: H3Event): PlatformAuth {
  const p = event.context.platform as PlatformAuth | null | undefined
  if (!p) throw createError({ statusCode: 401, data: { code: 'auth_required', message: 'Потрібен вхід оператора' } })
  return p
}
