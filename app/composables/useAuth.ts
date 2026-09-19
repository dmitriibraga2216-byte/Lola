export interface Me {
  user: { id: string, fullName: string, phone: string | null, email: string | null, locale: string | null, status: string, roles: { code: string, name: string }[], position: string | null, location: string | null }
  tenant: { id: string, slug: string, name: string, locale: string, timezone: string }
  scopes: string[]
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

  /** Инициалы для аватара: «Ткаченко Аліна» → «ТА». */
  const initials = computed(() => (me.value?.user.fullName ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join(''))

  return { me, loaded, fetchMe, logout, hasScope, initials }
}
