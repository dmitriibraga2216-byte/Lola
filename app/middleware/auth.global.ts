/** Гард: без сессии — на /login; с сессией /login не показываем. */
export default defineNuxtRouteMiddleware(async (to) => {
  const publicPages = new Set(['/login', '/ops'])
  const { me, loaded, fetchMe } = useAuth()

  if (!loaded.value) await fetchMe()

  if (to.path.startsWith('/m/')) return // тайный покупатель — по одноразовой ссылке без входа (docs/20 §7.8)
  // Публичная страница вакансии и форма отклика (docs/v2/29 §5.4, §6.3): человек приходит
  // из объявления, сессии у него нет и быть не должно — редирект на /login отправлял бы
  // соискателя логиниться в систему компании, куда он ещё только хочет попасть.
  if (to.path.startsWith('/j/')) return
  if (!me.value && !publicPages.has(to.path)) {
    return navigateTo('/login')
  }
  if (me.value && to.path === '/login') {
    return navigateTo('/')
  }
})
