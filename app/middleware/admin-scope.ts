/**
 * Гард админки: без нужного скоупа — на главную (приёмка этапа 1). `requiredAnyScope` — страница,
 * которую открывают разные роли по разным правам (магазин: каталог — `shop.manage`, выдача —
 * `shop.issue`); достаточно любого из списка.
 */
export default defineNuxtRouteMiddleware((to) => {
  const { hasScope } = useAuth()
  const anyOf = to.meta.requiredAnyScope as string[] | undefined
  if (anyOf?.length) {
    if (!anyOf.some(s => hasScope(s))) return navigateTo('/')
    return
  }
  const required = (to.meta.requiredScope as string | undefined) ?? 'people.view'
  if (!hasScope(required)) {
    return navigateTo('/')
  }
})
