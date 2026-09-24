export interface RoleRef { id: string, code: string, name: string }

export interface Me {
  user: { id: string, fullName: string, phone: string | null, email: string | null, locale: string | null, status: string, kind?: 'employee' | 'candidate', roles: RoleRef[], position: string | null, location: string | null }
  tenant: { id: string, slug: string, name: string, locale: string, timezone: string, accent: 'sun' | 'teal' | 'coral' | 'ink', modules: Record<string, boolean>, candidatesEnabled: boolean, localesEnabled: string[], passwordMinLength: number }
  /** Скоупы активной роли (docs/01 §1.9.2) */
  scopes: string[]
  activeRole: RoleRef | null
  /** Все действующие роли — для переключателя */
  roles: RoleRef[]
  impersonated: boolean
  /** Вход «от имени» (docs/24 §4.5): оператор, причина, до когда — для плашки */
  impersonation: { operator: string | null, reason: string | null, expiresAt: string } | null
  /** «Переглянути систему як роль» (docs/24 §3.5, докс/33 D-052): не null, поки триває перегляд */
  preview: RoleRef | null
}

export function useAuth() {
  const me = useState<Me | null>('auth:me', () => null)
  const loaded = useState<boolean>('auth:loaded', () => false)
  const { api } = useApi()

  async function fetchMe(): Promise<Me | null> {
    try {
      me.value = await api<Me>('/auth/me')
    }
    catch {
      me.value = null
    }
    loaded.value = true
    return me.value
  }

  async function logout(): Promise<void> {
    try {
      await api('/auth/logout', { method: 'POST' })
    }
    finally {
      me.value = null
      await navigateTo('/login')
    }
  }

  function hasScope(scope: string): boolean {
    return me.value?.scopes.includes(scope) ?? false
  }

  /** Модуль включён в простори (docs/24 §3.2); неизвестный — считаем включённым, чтобы не прятать чужие разделы. */
  function moduleOn(module: string): boolean {
    return me.value?.tenant?.modules?.[module] ?? true
  }

  /**
   * Рекрутинг включён у простору (docs/v2/28, `tenants.candidates_enabled`). На відміну від
   * модулів, умовчання — **вимкнено**: поки тенант свідомо не увімкнув воронку, розділу в
   * меню немає, а його ручки відповідають `403 candidates.disabled`.
   */
  function recruitingOn(): boolean {
    return me.value?.tenant?.candidatesEnabled === true
  }

  /** Кнопка «Вихід» на плашке «Ви увійшли як …»: сессия «от имени» закрывается, событие impersonation.ended. */
  async function stopImpersonation(): Promise<void> {
    try { await api('/auth/impersonation/stop', { method: 'POST' }) }
    finally { me.value = null; await navigateTo('/login') }
  }

  /** «Переглянути систему як роль» (docs/24 §3.5): старт із екрана ролей. */
  async function startPreview(roleId: string): Promise<void> {
    await api('/settings/roles/preview-as', { method: 'POST', body: { roleId } })
    await fetchMe()
    await navigateTo(homeFor(me.value))
  }

  /** Кнопка «Вихід» на плашці перегляду — повертає власні права без виходу з сесії. */
  async function stopPreview(): Promise<void> {
    await api('/settings/roles/preview-as', { method: 'DELETE' })
    await fetchMe()
    await navigateTo(homeFor(me.value))
  }

  /**
   * Переключение активной роли без выхода (docs/01 §1.9.2): сервер меняет сессию,
   * профиль перечитывается, экран уходит на стартовую — меню под новой ролью может не содержать текущего раздела.
   */
  async function switchRole(roleId: string): Promise<RoleRef> {
    const r = await api<{ activeRole: RoleRef, changed: boolean }>('/me/role/switch', { method: 'POST', body: { roleId } })
    await fetchMe()
    if (r.changed) await navigateTo(homeFor(me.value))
    return r.activeRole
  }

  /** Инициалы для аватара: «Ткаченко Аліна» → «ТА». */
  const initials = computed(() => (me.value?.user.fullName ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join(''))

  return { me, loaded, fetchMe, logout, hasScope, moduleOn, recruitingOn, stopImpersonation, startPreview, stopPreview, switchRole, initials }
}

/** Стартовый экран под активную роль: админка, если роль даёт туда доступ, иначе кабинет. */
export function homeFor(me: Me | null): string {
  const has = (s: string) => me?.scopes.includes(s) ?? false
  if (has('assignment.create')) return '/admin/assignments'
  if (has('course.view')) return '/admin/courses'
  if (has('people.view')) return '/admin/people'
  return '/learn'
}
