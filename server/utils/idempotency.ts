import type { H3Event } from 'h3'
import { IDEMPOTENCY_KEY_RE, beginIdempotent, finishIdempotent, releaseIdempotent, requestFingerprint } from '../services/idempotency'
import { apiError } from './apiResponse'

/**
 * Обёртка ручки с заголовком `Idempotency-Key` (docs/04 §4.1). Без заголовка — обычное
 * выполнение: ключ необязателен, старые клиенты и интеграции работают как раньше. Вызывается
 * после проверки прав — ключ живёт в пространстве «тенант × человек».
 */
export async function idempotent(event: H3Event, a: { tenantId: string, userId: string }, fn: () => Promise<unknown>): Promise<unknown> {
  const key = getRequestHeader(event, 'idempotency-key')
  if (key === undefined) return fn()
  if (!IDEMPOTENCY_KEY_RE.test(key)) return apiError(event, 400, 'idempotency.key_invalid', 'Некоректний Idempotency-Key: 1–255 друкованих символів без пробілів')
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const body = event.method === 'GET' ? null : await readBody(event).catch(() => null)
  const begin = await beginIdempotent(ctx, key, requestFingerprint(event.method, event.path, body))
  switch (begin.kind) {
    case 'mismatch':
      return apiError(event, 422, 'idempotency.key_reused', 'Цей Idempotency-Key уже використано для іншого запиту — створіть новий ключ')
    case 'in_progress':
      return apiError(event, 409, 'idempotency.in_progress', 'Попередній запит з цим ключем ще виконується — повторіть за кілька секунд')
    case 'replay':
      setResponseStatus(event, begin.status)
      setResponseHeader(event, 'Idempotent-Replayed', 'true')
      return begin.body
  }
  let result: unknown
  try {
    result = await fn()
  }
  catch (err) {
    await releaseIdempotent(ctx, begin.id)
    throw err
  }
  await finishIdempotent(ctx, begin.id, getResponseStatus(event), result)
  return result
}
