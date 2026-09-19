/**
 * Обёртка над $fetch: CSRF-заголовок из cookie + разворачивание { data } / { error }.
 * useRequestFetch пробрасывает cookie браузера при SSR — иначе сервер не видел бы сессию.
 */
export function useApi() {
  const csrf = useCookie('lola_csrf')
  const requestFetch = useRequestFetch()

  async function api<T>(path: string, opts: Parameters<typeof $fetch>[1] = {}): Promise<T> {
    const method = String(opts.method || 'GET').toUpperCase()
    const headers: Record<string, string> = { ...(opts.headers as Record<string, string> || {}) }
    if (method !== 'GET' && csrf.value) headers['x-csrf-token'] = csrf.value

    const res = await requestFetch<{ data: T }>(`/api/v1${path}`, { ...opts, headers } as never) as { data: T }
    return res.data
  }

  return { api, csrf }
}

export interface ApiErrorBody {
  error: { code: string, message: string, details?: Record<string, unknown> }
}

/** Достаёт код и сообщение из ошибки $fetch. */
export function apiErrorOf(err: unknown): { code: string, message: string, details?: Record<string, unknown> } {
  const data = (err as { data?: ApiErrorBody })?.data
  if (data?.error) return data.error
  return { code: 'internal', message: 'Щось пішло не так. Спробуйте ще раз' }
}
