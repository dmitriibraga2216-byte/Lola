/** Гард админки: без нужного скоупа — на главную (приёмка этапа 1). */
export default defineNuxtRouteMiddleware((to) => {
  const { hasScope } = useAuth()
  const required = (to.meta.requiredScope as string | undefined) ?? 'people.view'
  if (!hasScope(required)) {
    return navigateTo('/')
  }
})
