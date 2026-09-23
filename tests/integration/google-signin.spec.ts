import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cookieOf, makeEvent } from './_nitroGlobals'

/**
 * Вход через Google (docs/09 §9.1). Разбор поломки: `redirectUri()` не смотрел на `purpose`, поэтому
 * после экрана согласия провайдер возвращал человека в колбек интеграций, а тот звал `handleCallback`
 * и рендерил окно «Підключено як …» — сессия не заводилась, state был уже потреблён, повторить нечем.
 * Приёмка: колбек ветвится по `purpose`, вход просит только права личности, а `redirect_uri` в ссылке
 * авторизации и в обмене кода совпадают в обоих режимах `OAUTH_SIGNIN_CALLBACK`.
 *
 * `_nitroGlobals` (статический импорт выше) кладёт автоимпорты Nitro в globalThis до того, как ниже
 * подгружаются сами маршруты, — иначе их модули не разберутся.
 */

const oauth = await import('../../server/services/oauth')
const integrationsCallback = (await import('../../server/api/v1/integrations/[provider]/callback.get')).default as unknown as (event: ReturnType<typeof makeEvent>) => Promise<unknown>
const authCallback = (await import('../../server/api/v1/auth/google/callback.get')).default as unknown as (event: ReturnType<typeof makeEvent>) => Promise<unknown>

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const SESSION_COOKIE = 'lola_sid'
const APP_URL = 'https://lola.test'
const SIGNIN_EMAIL = 'signin-probe@kappi.ua'

let tenantId: string
let userId: string
/** Админ тенанта: подключение интеграции всегда делает человек — от него пишутся секреты и аудит. */
let adminId: string
/** Кого вернёт userinfo провайдера — меняется по тесту. */
let profileEmail = SIGNIN_EMAIL

const calls: { url: string, body?: string }[] = []
function fakeHttp(url: string, init?: RequestInit): Promise<Response> {
  calls.push({ url, body: typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : undefined })
  const json = (o: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } }))
  if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 })
  if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) return json({ email: profileEmail })
  return json({ error: 'unknown url ' + url }, 404)
}

const stateOf = (url: string) => new URL(url).searchParams.get('state')!
const redirectUriOf = (url: string) => new URL(url).searchParams.get('redirect_uri')!
const exchangeRedirectUri = () => new URLSearchParams(calls.find(c => c.url.startsWith('https://oauth2.googleapis.com/token'))!.body!).get('redirect_uri')
const sessionCount = async () => Number((await admin`select count(*)::int as c from sessions where user_id = ${userId}`)[0]!.c)

/** Ссылка на вход и ответ общего колбека интеграций — путь, которым живой пользователь ходит сейчас. */
async function signinThroughIntegrationsCallback() {
  const link = await oauth.authUrl({ tenantId, actorId: null }, 'google', 'signin')
  if ('error' in link) throw new Error('нет ссылки входа')
  const event = makeEvent({ path: '/api/v1/integrations/google/callback', params: { provider: 'google' }, query: { code: 'good', state: stateOf(link.url) } })
  const body = await integrationsCallback(event)
  return { link: link.url, event, body }
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  userId = (await admin`
    insert into users (tenant_id, full_name, email, status, kind)
    values (${tenantId}, 'Вхід Тестовий', ${SIGNIN_EMAIL}, 'active', 'employee') returning id`)[0]!.id as string
  process.env.GOOGLE_CLIENT_ID = 'test-client'
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret'
  process.env.APP_URL = APP_URL
  oauth.setOAuthHttp(fakeHttp)
})
afterEach(() => {
  calls.length = 0
  profileEmail = SIGNIN_EMAIL
  delete process.env.OAUTH_SIGNIN_CALLBACK
})
afterAll(async () => {
  oauth.setOAuthHttp(null)
  delete process.env.APP_URL
  await admin`delete from security_log where tenant_id = ${tenantId} and user_id = ${userId}`
  await admin`delete from sessions where user_id = ${userId}`
  await admin`delete from oauth_states where tenant_id = ${tenantId}`
  await admin`delete from tenant_secrets where tenant_id = ${tenantId} and provider = 'google'`
  await admin`delete from users where id = ${userId}`
  await admin.end()
})

describe('вход через Google: колбек ветвится по purpose (docs/09 §9.1)', () => {
  it('purpose=signin в колбеке интеграций: сессия, cookie и редирект на /, а не окно «Підключено»', async () => {
    const before = await sessionCount()
    const { event, body } = await signinThroughIntegrationsCallback()

    expect(event._redirect).toBe('/')
    expect(event._status).toBe(302)
    expect(cookieOf(event, SESSION_COOKIE)).toBeTruthy()
    // Именно это и видел владелец продукта: «успех» страницей вместо входа
    expect(String(body)).not.toContain('Підключено')
    expect(event._headers['content-type']).toBeUndefined()

    expect(await sessionCount()).toBe(before + 1)
    const [s] = await admin`select login_method from sessions where user_id = ${userId} order by created_at desc limit 1`
    expect(s!.login_method).toBe('google')
    const [sec] = await admin`select count(*)::int as c from security_log where tenant_id = ${tenantId} and user_id = ${userId} and event = 'login.success'`
    expect(Number(sec!.c)).toBeGreaterThanOrEqual(1)
  })

  it('нет ровно одного активного человека с таким e-mail: /login?error=google_no_user, сессия не создаётся', async () => {
    profileEmail = 'nobody-here@kappi.ua'
    const before = await sessionCount()
    const { event } = await signinThroughIntegrationsCallback()

    expect(event._redirect).toBe('/login?error=google_no_user')
    expect(cookieOf(event, SESSION_COOKIE)).toBeUndefined()
    expect(await sessionCount()).toBe(before)
  })

  it('purpose=connect: по-прежнему HTML «Підключено», сессии и cookie нет', async () => {
    const before = await sessionCount()
    const link = await oauth.authUrl({ tenantId, actorId: adminId }, 'google', 'connect')
    if ('error' in link) throw new Error('нет ссылки подключения')
    const event = makeEvent({ path: '/api/v1/integrations/google/callback', params: { provider: 'google' }, query: { code: 'good', state: stateOf(link.url) } })
    const body = await integrationsCallback(event)

    expect(event._redirect).toBeNull()
    expect(String(body)).toContain('<!doctype html>')
    expect(String(body)).toContain('Підключено як')
    expect(event._headers['content-type']).toBe('text/html; charset=utf-8')
    expect(cookieOf(event, SESSION_COOKIE)).toBeUndefined()
    expect(await sessionCount()).toBe(before)
  })
})

describe('права запрашиваются по назначению', () => {
  it('ссылка входа — только личность, без offline/consent; ссылка подключения — рабочие права', async () => {
    const signin = await oauth.authUrl({ tenantId, actorId: null }, 'google', 'signin')
    const connect = await oauth.authUrl({ tenantId, actorId: adminId }, 'google', 'connect')
    if ('error' in signin || 'error' in connect) throw new Error('нет ссылок')

    const s = new URL(signin.url).searchParams
    expect(s.get('scope')).toBe('openid email profile')
    expect(s.get('scope')).not.toContain('calendar.events')
    expect(s.get('scope')).not.toContain('admin.directory.user.readonly')
    expect(s.get('prompt')).toBeNull()
    expect(s.get('access_type')).toBeNull()

    const c = new URL(connect.url).searchParams
    expect(c.get('scope')).toContain('https://www.googleapis.com/auth/calendar.events')
    expect(c.get('scope')).toContain('https://www.googleapis.com/auth/admin.directory.user.readonly')
    expect(c.get('prompt')).toBe('consent')
    expect(c.get('access_type')).toBe('offline')
  })
})

describe('redirect_uri: ссылка авторизации и обмен кода совпадают', () => {
  it('shared (по умолчанию): общий путь интеграций, вход чинится без новой регистрации адреса', async () => {
    const { link, event } = await signinThroughIntegrationsCallback()
    const expected = `${APP_URL}/api/v1/integrations/google/callback`

    expect(redirectUriOf(link)).toBe(expected)
    expect(exchangeRedirectUri()).toBe(expected)
    expect(event._redirect).toBe('/')
  })

  it('split: собственный путь входа, тот же адрес в обмене кода, вход завершает /api/v1/auth/google/callback', async () => {
    process.env.OAUTH_SIGNIN_CALLBACK = 'split'
    const link = await oauth.authUrl({ tenantId, actorId: null }, 'google', 'signin')
    if ('error' in link) throw new Error('нет ссылки входа')
    const expected = `${APP_URL}/api/v1/auth/google/callback`
    expect(redirectUriOf(link.url)).toBe(expected)

    const event = makeEvent({ path: '/api/v1/auth/google/callback', query: { code: 'good', state: stateOf(link.url) } })
    await authCallback(event)

    expect(exchangeRedirectUri()).toBe(expected)
    expect(event._redirect).toBe('/')
    expect(cookieOf(event, SESSION_COOKIE)).toBeTruthy()
  })

  it('подключение интеграции остаётся на пути интеграций и в режиме split', async () => {
    process.env.OAUTH_SIGNIN_CALLBACK = 'split'
    const connect = await oauth.authUrl({ tenantId, actorId: adminId }, 'google', 'connect')
    if ('error' in connect) throw new Error('нет ссылки подключения')
    expect(redirectUriOf(connect.url)).toBe(`${APP_URL}/api/v1/integrations/google/callback`)
  })
})
