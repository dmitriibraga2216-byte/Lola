/**
 * Заглушки автоимпортов Nitro (defineEventHandler, getQuery, setCookie, sendRedirect …) для тестов,
 * которым нужно позвать сам обработчик маршрута, не поднимая Nuxt. В vitest автоимпортов нет: без
 * этих глобалей модуль маршрута падает ещё на разборе (`defineEventHandler is not defined`).
 *
 * Контракт тот же, что у h3: обработчик получает событие, читает из него query/заголовки и пишет
 * cookie/редирект. Здесь событие — простой объект, а всё записанное складывается в поля с подчёркиванием,
 * чтобы тест мог проверить, что именно ушло клиенту. Сам h3 не импортируется: в строгом дереве pnpm
 * он не прямая зависимость проекта.
 *
 * Файл называется с подчёркивания и потому не попадает под vitest include (`**\/*.spec.ts`).
 */

export interface FakeEvent {
  node: { req: { method: string, url: string, headers: Record<string, string>, socket: { remoteAddress: string } } }
  context: Record<string, unknown>
  path: string
  _query: Record<string, string>
  _params: Record<string, string>
  _headers: Record<string, string>
  _cookies: { name: string, value: string }[]
  _redirect: string | null
  _status: number | null
  /** Тело POST-запроса — то, что вернёт `readBody` */
  _body?: unknown
}

export function makeEvent(input: { path?: string, query?: Record<string, string>, params?: Record<string, string>, headers?: Record<string, string>, body?: unknown } = {}): FakeEvent {
  const path = input.path ?? '/'
  return {
    node: { req: { method: 'GET', url: path, headers: { 'user-agent': 'vitest', ...input.headers }, socket: { remoteAddress: '127.0.0.1' } } },
    context: {},
    path,
    _query: input.query ?? {},
    _params: input.params ?? {},
    _headers: {},
    _cookies: [],
    _redirect: null,
    _status: null,
    _body: input.body,
  }
}

/** Cookie по имени из того, что обработчик успел поставить. */
export const cookieOf = (event: FakeEvent, name: string): string | undefined => event._cookies.find(c => c.name === name)?.value

const g = globalThis as unknown as Record<string, unknown>

g.defineEventHandler = (fn: unknown) => fn
g.getQuery = (event: FakeEvent) => event._query
g.getRouterParam = (event: FakeEvent, name: string) => event._params[name]
g.getHeader = (event: FakeEvent, name: string) => event.node.req.headers[name.toLowerCase()]
g.setHeader = (event: FakeEvent, name: string, value: string) => { event._headers[name.toLowerCase()] = value }
g.getCookie = (event: FakeEvent, name: string) => cookieOf(event, name)
g.setCookie = (event: FakeEvent, name: string, value: string) => { event._cookies.push({ name, value }) }
g.deleteCookie = (event: FakeEvent, name: string) => { event._cookies = event._cookies.filter(c => c.name !== name) }
g.sendRedirect = (event: FakeEvent, location: string, status = 302) => { event._redirect = location; event._status = status; return Promise.resolve('') }
g.readBody = (event: FakeEvent) => Promise.resolve(event._body)
// `apiError()` ставит статус ответа — его и проверяет тест, когда обработчик отвечает, а не бросает
g.setResponseStatus = (event: FakeEvent, status: number) => { event._status = status }
g.setResponseHeader = (event: FakeEvent, name: string, value: string | number) => { event._headers[name.toLowerCase()] = String(value) }
g.createError = (init: { statusCode?: number, data?: unknown }) => Object.assign(new Error(`http ${init.statusCode ?? 500}`), init)
