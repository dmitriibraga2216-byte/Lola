export interface RoleRef { id: string, code: string, name: string }

export interface Me {
  user: { id: string, fullName: string, phone: string | null, email: string | null, locale: string | null, status: string, roles: RoleRef[], position: string | null, location: string | null }
  tenant: { id: string, slug: string, name: string, locale: string, timezone: string }
  /** Скоупы активной роли (docs/01 §1.9.2) */
  scopes: string[]
  activeRole: RoleRef | null
  /** Все действующие роли — для переключателя */
  roles: RoleRef[]
  impersonated: boolean
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

  return { me, loaded, fetchMe, logout, hasScope, switchRole, initials }
}

/** Стартовый экран под активную роль: админка, если роль даёт туда доступ, иначе кабинет. */
export function homeFor(me: Me | null): string {
  const has = (s: string) => me?.scopes.includes(s) ?? false
  if (has('assignment.create')) return '/admin/assignments'
  if (has('course.view')) return '/admin/courses'
  if (has('people.view')) return '/admin/people'
  return '/learn'
}
