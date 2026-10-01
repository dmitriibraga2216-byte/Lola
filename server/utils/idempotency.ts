import { createHash } from 'node:crypto'
import type { H3Event } from 'h3'
import { IDEMPOTENCY_KEY_RE, beginIdempotent, finishIdempotent, releaseIdempotent, requestFingerprint } from '../services/idempotency'
import { apiError } from './apiResponse'

/**
 * Обёртка ручки с заголовком `Idempotency-Key` (docs/04 §4.1). Без заголовка — обычное
 * выполнение: ключ необязателен, старые клиенты и интеграции работают как раньше. Вызывается
 * после проверки прав — ключ живёт в пространстве «тенант × человек».
 *
 * `required` — ручка с побочным эффектом снаружи (публикация на площадку, `v2/41` §5.3): без
 * заголовка — `400 idempotency.key_required`, мутация не выполняется.
 */
export async function idempotent(event: H3Event, a: { tenantId: string, userId: string }, fn: () => Promise<unknown>, opts: { required?: boolean } = {}): Promise<unknown> {
  const key = getRequestHeader(event, 'idempotency-key')
  if (key === undefined) {
    if (opts.required) return apiError(event, 400, 'idempotency.key_required', 'Потрібен заголовок Idempotency-Key — оновіть сторінку й повторіть дію')
    return fn()
  }
  if (!IDEMPOTENCY_KEY_RE.test(key)) return apiError(event, 400, 'idempotency.key_invalid', 'Некоректний Idempotency-Key: 1–255 друкованих символів без пробілів')
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const body = event.method === 'GET' ? null : await requestBodyForFingerprint(event)
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

/**
 * Тело для отпечатка. Multipart (импорт CSV) — по частям: имя, файл, тип и хэш содержимого, без
 * границы — повтор того же файла клиентом идёт с новой границей, и сырое тело бы не совпало.
 */
async function requestBodyForFingerprint(event: H3Event): Promise<unknown> {
  if (/^multipart\//i.test(getRequestHeader(event, 'content-type') ?? '')) {
    const parts = await readMultipartFormData(event).catch(() => undefined)
    return (parts ?? []).map(p => ({ name: p.name ?? null, filename: p.filename ?? null, type: p.type ?? null, sha256: createHash('sha256').update(p.data).digest('hex') }))
  }
  return readBody(event).catch(() => null)
}
