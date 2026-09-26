/**
 * Гард экранов консоли оператора (docs/25 §7 п. 6–8): без сессии — вход, с незавершённым вторым
 * фактором — экран 2FA. Только в браузере (см. `useOps`); сервер всё равно отвечает 401 любой ручкой.
 */
export default defineNuxtRouteMiddleware(async () => {
  if (import.meta.server) return
  const { me, fetchMe } = useOps()
  const who = me.value ?? await fetchMe()
  if (!who) return navigateTo('/ops/login')
  if (who.twoFactor) return navigateTo('/ops/two-factor')
})
