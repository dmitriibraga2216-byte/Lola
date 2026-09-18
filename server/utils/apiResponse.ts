import type { H3Event } from 'h3'

/** Единый формат ошибки (docs/04-api.md §4.1). Коды стабильны, их использует клиент. */
export function apiError(
  event: H3Event,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): { error: { code: string, message: string, details?: Record<string, unknown> } } {
  setResponseStatus(event, status)
  return { error: { code, message, ...(details ? { details } : {}) } }
}

export function apiData<T>(data: T): { data: T } {
  return { data }
}
