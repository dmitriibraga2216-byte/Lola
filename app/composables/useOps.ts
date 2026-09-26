/**
 * Консоль оператора платформы (docs/25 §7 п. 6–8): свой API `/api/v1/platform/*`, своя cookie,
 * своя сессия и роль. Права решает сервер (`platformCan()`), здесь — только спрятать кнопку.
 * Данные грузятся в браузере: на отдельном хосте консоли (`OPS_HOST`) SSR-запрос внутри сервера
 * мог бы уйти без исходного `Host`.
 */
export interface OpsMe {
  adminId: string
  email: string
  fullName: string
  role: 'owner' | 'admin' | 'billing' | 'support' | 'viewer'
  /** Шаг второго фактора промежуточной сессии; null — вход завершён */
  twoFactor: 'verify' | 'enroll' | null
  actions: string[]
  hostBase: string | null
}

// Нетипизированный вызов: типизированные роуты Nitro при сотнях эндпоинтов дают TS2589
const rawFetch = $fetch as unknown as <T>(url: string, opts?: unknown) => Promise<T>

export function useOps() {
  const me = useState<OpsMe | null>('ops:me', () => null)
  const loaded = useState<boolean>('ops:loaded', () => false)

  async function raw<T>(path: string, opts: { method?: string, body?: unknown, query?: Record<string, unknown> } = {}): Promise<T> {
    try {
      return await rawFetch<T>(`/api/v1/platform${path}`, opts)
    }
    catch (err) {
      const code = apiErrorOf(err).code
      // Сессия истекла или второй фактор не пройден — на свой экран, а не ошибкой посреди страницы
      if (code === 'auth_required') { me.value = null; await navigateTo('/ops/login') }
      else if (code === 'two_factor_required') await navigateTo('/ops/two-factor')
      throw err
    }
  }

  async function ops<T>(path: string, opts: { method?: string, body?: unknown, query?: Record<string, unknown> } = {}): Promise<T> {
    return (await raw<{ data: T }>(path, opts)).data
  }

  async function fetchMe(): Promise<OpsMe | null> {
    try { me.value = (await rawFetch<{ data: OpsMe }>('/api/v1/platform/me')).data }
    catch { me.value = null }
    loaded.value = true
    return me.value
  }

  function can(action: string): boolean {
    return me.value?.actions.includes(action) ?? false
  }

  async function logout(): Promise<void> {
    try { await rawFetch('/api/v1/platform/logout', { method: 'POST' }) }
    finally {
      me.value = null
      await navigateTo('/ops/login')
    }
  }

  return { me, loaded, ops, raw, fetchMe, can, logout }
}
