/**
 * Обёртка над $fetch: CSRF-заголовок из cookie + разворачивание { data } / { error }.
 * useRequestFetch пробрасывает cookie браузера при SSR — иначе сервер не видел бы сессию.
 */
export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  query?: Record<string, unknown>
  headers?: Record<string, string>
  /**
   * Мутация, которую безопасно повторить (docs/04 §4.1): запрос уходит с новым `Idempotency-Key`,
   * и обрыв сети или 5xx повторяются тем же ключом — сервер выполнит действие не больше одного раза.
   */
  idempotent?: boolean
}

/** Повторы идемпотентной мутации: сеть, таймаут, перегрузка, сбой сервера — не ошибки клиента. */
const IDEMPOTENT_RETRY = { retry: 2, retryDelay: 800, retryStatusCodes: [408, 425, 429, 500, 502, 503, 504] }

function newIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function useApi() {
  const csrf = useCookie('lola_csrf')
  const requestFetch = useRequestFetch()

  /**
   * CSRF-токен на момент запроса. В браузере — прямо из `document.cookie`: сервер переставляет
   * cookie при входе и при подтверждении второго фактора (docs/24 §3.4), а ref `useCookie`,
   * созданный до этого, помнит старое значение — мутация с экрана входа ушла бы без токена.
   */
  function csrfToken(): string | null {
    if (import.meta.client) {
      const m = document.cookie.match(/(?:^|;\s*)lola_csrf=([^;]*)/)
      if (m) return decodeURIComponent(m[1]!)
    }
    return csrf.value ?? null
  }

  // Явный тип опций вместо Parameters<typeof $fetch>[1]: типизированные роуты Nitro при 300+ эндпоинтах
  // упираются в глубину инстанцирования (TS2589) в компонентах
  async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
    const method = String(opts.method || 'GET').toUpperCase()
    const headers: Record<string, string> = { ...(opts.headers as Record<string, string> || {}) }
    const token = method !== 'GET' ? csrfToken() : null
    if (token) headers['x-csrf-token'] = token
    const { idempotent, ...rest } = opts
    if (idempotent) headers['idempotency-key'] = newIdempotencyKey()

    const res = await (requestFetch as unknown as (url: string, o: unknown) => Promise<{ data: T }>)(`/api/v1${path}`, { ...rest, ...(idempotent ? IDEMPOTENT_RETRY : {}), headers })
    return res.data
  }

  /** Полный ответ (data + meta) — для списков с курсором. */
  async function apiRaw<T>(path: string, opts: ApiOptions = {}): Promise<T> {
    const method = String(opts.method || 'GET').toUpperCase()
    const headers: Record<string, string> = { ...(opts.headers ?? {}) }
    const token = method !== 'GET' ? csrfToken() : null
    if (token) headers['x-csrf-token'] = token
    return (requestFetch as unknown as (url: string, o: unknown) => Promise<T>)(`/api/v1${path}`, { ...opts, headers })
  }

  return { api, apiRaw, csrf }
}

export interface ApiErrorBody {
  error: { code: string, message: string, details?: Record<string, unknown> }
}

/** Достаёт код и сообщение из ошибки $fetch. */
export function apiErrorOf(err: unknown): { code: string, message: string, details?: Record<string, unknown> } {
  const data = (err as { data?: ApiErrorBody })?.data
  if (data?.error) return data.error
  // Ответ без конверта ошибки: сеть, прокси, таймаут. Текст говорит, что делать (замечание 27.09)
  return { code: 'internal', message: 'Сервер не відповів. Перевірте зʼєднання з інтернетом і спробуйте ще раз — якщо повторюється, оновіть сторінку' }
}
