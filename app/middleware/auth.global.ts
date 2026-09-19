/** Гард: без сессии — на /login; с сессией /login не показываем. */
export default defineNuxtRouteMiddleware(async (to) => {
  const publicPages = new Set(['/login', '/ops'])
  const { me, loaded, fetchMe } = useAuth()

  if (!loaded.value) await fetchMe()

  if (to.path.startsWith('/m/')) return // тайный покупатель — по одноразовой ссылке без входа (docs/20 §7.8)
  if (!me.value && !publicPages.has(to.path)) {
    return navigateTo('/login')
  }
  if (me.value && to.path === '/login') {
    return navigateTo('/')
  }
})
