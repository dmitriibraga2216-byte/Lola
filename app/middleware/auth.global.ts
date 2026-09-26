/** Гард: без сессии — на /login; с сессией /login не показываем. */
export default defineNuxtRouteMiddleware(async (to) => {
  // /invite — ссылка-приглашение (docs/01 §1.5 «для первого входу»): людина ще без сесії,
  // редірект на /login показав би форму входу замість завершення запрошення (PR-16 тут спіткнувся)
  const publicPages = new Set(['/login', '/invite'])
  // Консоль оператора (`/ops`, `/ops/*`) — своя сессия и свой гард (`ops-auth`); тенантская сессия
  // ей не нужна, а на отдельном хосте консоли (`OPS_HOST`) тенантский `/auth/me` и вовсе 404
  if (to.path === '/ops' || to.path.startsWith('/ops/')) return
  const { me, loaded, fetchMe } = useAuth()

  if (!loaded.value) await fetchMe()

  if (to.path.startsWith('/m/')) return // тайный покупатель — по одноразовой ссылке без входа (docs/20 §7.8)
  // Публичная страница вакансии и форма отклика (docs/v2/29 §5.4, §6.3): человек приходит
  // из объявления, сессии у него нет и быть не должно — редирект на /login отправлял бы
  // соискателя логиниться в систему компании, куда он ещё только хочет попасть.
  if (to.path.startsWith('/j/')) return
  // «Підсумок кандидата» за посиланням з листа (docs/v2/30 §5.4, §10): кандидат читає документ
  // без входу — посилання і є доступом, строк його дії 30 днів, відкликання закриває його одразу
  if (to.path.startsWith('/summary/')) return
  if (!me.value && !publicPages.has(to.path)) {
    return navigateTo('/login')
  }
  if (me.value && (to.path === '/login' || to.path === '/invite')) {
    return navigateTo('/')
  }
})
