import { createHash, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeEvent, type FakeEvent } from './_nitroGlobals'

/**
 * Вход из Telegram-бота (docs/23 §6 п. 7, §7; docs/04 §4.19; критерий docs/23 §12 п. 4).
 *
 * Кнопка «Пройти» несёт одноразовый токен, выпущенный в момент, когда бот отправляет сообщение
 * конкретному человеку: 10 минут, один переход, в базе — только хеш, привязан к человеку и
 * пространству. `GET /tg/go` входит только по нему, отказ — один экран на все причины; сессию
 * создаёт `createSession()` со всеми её проверками. Свежую кнопку бот присылает по `/menu`.
 *
 * Кнопки здесь выпускает настоящий отправитель (`sendTelegram` с подменённым HTTP), а нажимает их
 * сам обработчик маршрута — путь тот же, что у живого сообщения. `_nitroGlobals` (статический
 * импорт выше) кладёт автоимпорты Nitro в globalThis до того, как ниже подгружается маршрут.
 */

const T = await import('../../server/services/telegram')
const N = await import('../../server/services/notifications')
const { createSession, validateSession } = await import('../../server/services/session')
const { withTenant } = await import('../../server/utils/withTenant')
const tgGo = (await import('../../server/routes/tg/go.get')).default as unknown as (event: FakeEvent) => Promise<unknown>

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const APP_URL = 'https://lola.test'
const SESSION_COOKIE = 'lola_sid'
const EXPIRED = '/login?error=tg_link_expired'
const MARK = 'BotLogin'
/** Адреса этого прогона: у каждого перехода свой, чтобы частотное ограничение не задевало соседние тесты. */
const NET = `10.96.${20 + Math.floor(Math.random() * 200)}`
let ipSeq = 0

const saved = { appUrl: process.env.APP_URL, botToken: process.env.TELEGRAM_BOT_TOKEN }
let tenantId: string
let otherTenantId: string
const people: string[] = []

interface Person { id: string, chatId: bigint }
interface Button { text: string, url?: string, callback_data?: string }
interface Sent { chat_id: string, text: string, reply_markup?: { inline_keyboard: Button[][] } }
const sent: Sent[] = []

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const tokenOf = (url: string) => new URL(url, APP_URL).searchParams.get('t')!
const tokenRow = async (url: string) => (await admin`select * from telegram_tokens where token_hash = ${sha256(tokenOf(url))}`)[0]
const sessionsOf = async (userId: string) => Number((await admin`select count(*)::int as c from sessions where user_id = ${userId}`)[0]!.c)
const tokensOf = async (userId: string) => Number((await admin`select count(*)::int as c from telegram_tokens where user_id = ${userId}`)[0]!.c)

/** Человек с привязанным Telegram — напрямую в БД: сценарию важны статус, вид и чат. */
async function person(patch: Record<string, unknown> = {}, inTenant = tenantId): Promise<Person> {
  const chatId = 9_600_000_000 + Math.floor(Math.random() * 99_999_999)
  const [row] = await admin`insert into users ${admin({ tenant_id: inTenant, kind: 'employee', full_name: `${MARK} ${people.length + 1}`, status: 'active', telegram_chat_id: chatId, ...patch })} returning id`
  people.push(row!.id as string)
  return { id: row!.id as string, chatId: BigInt(chatId) }
}

async function sentNotification(userId: string): Promise<string> {
  const [n] = await admin`insert into notifications (tenant_id, user_id, code, channel, payload, status, sent_at, dedup_key)
    values (${tenantId}, ${userId}, 'test_message', 'telegram', '{}', 'sent', now(), ${`bot-login:${randomUUID()}`}) returning id`
  return n!.id as string
}

/** Бот отправляет человеку сообщение с кнопкой — как при рассылке; ответ — адрес кнопки «Пройти». */
async function botButton(p: Person, url = '/learn', notificationId?: string): Promise<string> {
  sent.length = 0
  expect((await T.sendTelegram(tenantId, p.chatId, 'Курс чекає', { url, userId: p.id, notificationId })).ok).toBe(true)
  return sent.find(m => m.chat_id === String(p.chatId))!.reply_markup!.inline_keyboard[0]![0]!.url!
}

interface Pressed { redirect: string | null, sid: string | undefined, headers: Record<string, string> }

/** Переход по адресу, как браузер: query из адреса, обработчик маршрута; `sid` — cookie сессии, поставленная ответом. */
async function press(url: string, opts: { cookie?: string, hostTenantId?: string, ip?: string } = {}): Promise<Pressed> {
  const u = new URL(url, APP_URL)
  expect(u.pathname).toBe('/tg/go')
  const event = makeEvent({ path: `${u.pathname}${u.search}`, query: Object.fromEntries(u.searchParams), headers: { 'x-forwarded-for': opts.ip ?? `${NET}.${++ipSeq}` } })
  if (opts.cookie) event._cookies.push({ name: SESSION_COOKIE, value: opts.cookie }) // cookie, пришедшая с запросом
  if (opts.hostTenantId) event.context.hostTenant = { id: opts.hostTenantId }
  const before = event._cookies.length
  await tgGo(event)
  return { redirect: event._redirect, sid: event._cookies.slice(before).find(c => c.name === SESSION_COOKIE)?.value, headers: event._headers }
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  otherTenantId = (await admin`insert into tenants (slug, name, status) values (${`bot-login-${Date.now()}`}, 'Інший простір', 'active') returning id`)[0]!.id as string
  process.env.APP_URL = APP_URL
  process.env.TELEGRAM_BOT_TOKEN = 'test-token'
  T.setTelegramHttp((async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/sendMessage')) sent.push(JSON.parse(String(init?.body)) as Sent)
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch)
})

afterAll(async () => {
  T.setTelegramHttp(null)
  if (saved.appUrl === undefined) delete process.env.APP_URL
  else process.env.APP_URL = saved.appUrl
  if (saved.botToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
  else process.env.TELEGRAM_BOT_TOKEN = saved.botToken
  if (people.length) {
    await admin`delete from notifications where user_id in ${admin(people)}`
    await admin`delete from security_log where user_id in ${admin(people)}`
    await admin`delete from sessions where user_id in ${admin(people)}`
    await admin`delete from telegram_tokens where user_id in ${admin(people)}`
    await admin`delete from users where id in ${admin(people)}`
  }
  await admin`delete from tenants where id = ${otherTenantId}`
  await admin`delete from rate_limits where key like ${`tg:go:${NET}.%`}`
  await admin.end()
})

describe('кнопка «Пройти» выпускается в момент отправки сообщения (docs/23 §6 п. 7)', () => {
  it('в адресе — одноразовый токен, путь и уведомление, идентификатора чата нет; в базе — хеш и срок 10 минут', async () => {
    const p = await person()
    const nid = randomUUID()
    const url = await botButton(p, '/learn/abc', nid)
    const u = new URL(url)
    expect(`${u.origin}${u.pathname}`).toBe(`${APP_URL}/tg/go`)
    expect([...u.searchParams.keys()].sort()).toEqual(['n', 't', 'to'])
    expect(u.searchParams.get('to')).toBe('/learn/abc')
    expect(u.searchParams.get('n')).toBe(nid)
    expect(url).not.toContain(String(p.chatId))
    const t = tokenOf(url)
    expect(t).toMatch(/^[\w-]{32}$/)

    const rows = await admin`select kind, token_hash, expires_at, consumed_at, created_at from telegram_tokens where user_id = ${p.id}`
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'login', token_hash: sha256(t), consumed_at: null })
    expect(JSON.stringify(rows)).not.toContain(t)
    const ttlMin = (new Date(rows[0]!.expires_at).getTime() - new Date(rows[0]!.created_at).getTime()) / 60_000
    expect(ttlMin).toBeGreaterThan(9.9)
    expect(ttlMin).toBeLessThan(10.1)

    // Каждое сообщение — свой токен
    expect(tokenOf(await botButton(p))).not.toBe(t)
  })

  it('без адресата кнопка — обычная ссылка на страницу, токен не выпускается', async () => {
    const p = await person()
    sent.length = 0
    await T.sendTelegram(tenantId, p.chatId, 'Без адресата', { url: '/learn' })
    expect(sent.find(m => m.chat_id === String(p.chatId))!.reply_markup!.inline_keyboard[0]![0]!.url).toBe(`${APP_URL}/learn`)
    expect(await tokensOf(p.id)).toBe(0)
  })

  it('рассылка (notification.dispatch) выпускает кнопку на адресата уведомления, по ней входит он', async () => {
    const p = await person()
    await withTenant(tenantId, null, tx => N.enqueueNotification(tx, { tenantId, userId: p.id, code: 'test_message', payload: { url: '/learn' }, urgent: true, dedupKey: `bot-login:${p.id}` }))
    // Первой в очереди — чтобы окно рассылки дошло до неё при любом хвосте соседних спек
    await admin`update notifications set scheduled_for = '2000-01-01' where user_id = ${p.id} and status = 'queued'`
    sent.length = 0
    await N.dispatchNotifications(tenantId, 50)
    const [n] = await admin`select id, status from notifications where user_id = ${p.id}`
    expect(n!.status).toBe('sent')
    const url = sent.find(m => m.chat_id === String(p.chatId))!.reply_markup!.inline_keyboard[0]![0]!.url!
    expect(new URL(url).searchParams.get('n')).toBe(n!.id)

    const r = await press(url)
    expect(r.redirect).toBe('/learn')
    expect(await validateSession(r.sid!)).toMatchObject({ tenantId, userId: p.id })
    expect((await admin`select reacted_at from notifications where id = ${n!.id}`)[0]!.reacted_at).not.toBeNull()
  })
})

describe('GET /tg/go — вход только по одноразовому токену', () => {
  it('валидный токен — сессия этого человека, переход на страницу, реакция на уведомление, login.success', async () => {
    const p = await person()
    const nid = await sentNotification(p.id)
    const url = await botButton(p, '/learn/x', nid)
    const r = await press(url)
    expect(r.redirect).toBe('/learn/x')
    expect(r.headers['cache-control']).toBe('no-store')
    expect(await validateSession(r.sid!)).toMatchObject({ tenantId, userId: p.id, twoFactorPending: false })
    expect((await admin`select login_method from sessions where user_id = ${p.id}`)[0]!.login_method).toBe('otp_telegram')
    expect((await tokenRow(url))!.consumed_at).not.toBeNull()
    expect((await admin`select reacted_at from notifications where id = ${nid}`)[0]!.reacted_at).not.toBeNull()
    const [log] = await admin`select meta from security_log where user_id = ${p.id} and event = 'login.success'`
    expect(log!.meta).toMatchObject({ method: 'telegram' })
  })

  it('повторный переход по той же кнопке — отказ, новой сессии нет', async () => {
    const p = await person()
    const url = await botButton(p)
    expect((await press(url)).sid).toBeDefined()
    expect(await press(url)).toMatchObject({ redirect: EXPIRED, sid: undefined })
    expect(await sessionsOf(p.id)).toBe(1)
  })

  it('просроченный токен — отказ, сессии нет', async () => {
    const p = await person()
    const url = await botButton(p)
    await admin`update telegram_tokens set expires_at = now() - interval '1 second' where token_hash = ${sha256(tokenOf(url))}`
    expect(await press(url)).toMatchObject({ redirect: EXPIRED, sid: undefined })
    expect(await sessionsOf(p.id)).toBe(0)
  })

  it('идентификатор чата без токена — отказ в любом виде: сессии нет, токен не выпускается', async () => {
    const p = await person()
    const chat = String(p.chatId)
    const variants: Record<string, string>[] = [
      { c: chat, to: '/learn' },
      { c: chat, to: '/learn', n: randomUUID() },
      { c: chat, e: randomUUID() },
      { c: chat, t: '' },
      { c: chat, t: 'x'.repeat(32) },
      { c: chat, t: chat },
    ]
    for (const query of variants) {
      expect(await press(`/tg/go?${new URLSearchParams(query)}`), JSON.stringify(query)).toMatchObject({ redirect: EXPIRED, sid: undefined })
    }
    expect(await sessionsOf(p.id)).toBe(0)
    expect(await tokensOf(p.id)).toBe(0)
  })

  it('токен чужого пространства — отказ: на хосте другого пространства (и токен не тратится), строка токена не своего пространства', async () => {
    const p = await person()
    const url = await botButton(p)
    expect(await press(url, { hostTenantId: otherTenantId })).toMatchObject({ redirect: EXPIRED, sid: undefined })
    expect((await tokenRow(url))!.consumed_at).toBeNull()
    // На хосте своего пространства та же кнопка входит — отказ выше её не потратил
    const own = await press(url, { hostTenantId: tenantId })
    expect(await validateSession(own.sid!)).toMatchObject({ tenantId, userId: p.id })

    // Строка токена другого пространства, указывающая на этого человека: входа нет ни туда, ни сюда
    const raw = `foreign-${randomUUID().replaceAll('-', '')}`
    await admin`insert into telegram_tokens (tenant_id, user_id, kind, token_hash, expires_at) values (${otherTenantId}, ${p.id}, 'login', ${sha256(raw)}, now() + interval '10 minutes')`
    expect(await press(`/tg/go?t=${raw}&to=/learn`)).toMatchObject({ redirect: EXPIRED, sid: undefined })
    expect(await sessionsOf(p.id)).toBe(1)
    expect(Number((await admin`select count(*)::int as c from sessions where tenant_id = ${otherTenantId}`)[0]!.c)).toBe(0)
  })

  it('архивный кандидат с валидным токеном — отказ в createSession(): экран «Термін доступу завершився», сессии нет', async () => {
    const p = await person({ kind: 'candidate', candidate_state: 'archived', candidate_state_at: new Date() })
    const url = await botButton(p)
    expect(await press(url)).toMatchObject({ redirect: '/login?error=candidate_access_expired', sid: undefined })
    expect(await sessionsOf(p.id)).toBe(0)
  })

  it('право входа — на момент перехода: архивирован, заблокирован, отвязал Telegram после отправки — отказ; архивный не оживает', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['архивирован', { status: 'archived' }],
      ['заблокирован', { is_blocked: true, status: 'suspended' }],
      ['Telegram отвязан', { telegram_chat_id: null }],
    ]
    for (const [why, change] of cases) {
      const p = await person()
      const url = await botButton(p)
      await admin`update users set ${admin(change)} where id = ${p.id}`
      expect(await press(url), why).toMatchObject({ redirect: EXPIRED, sid: undefined })
      expect(await sessionsOf(p.id), why).toBe(0)
      const [u] = await admin`select status from users where id = ${p.id}`
      expect(u!.status, why).toBe(change.status ?? 'active')
    }
  })

  it('одновременные переходы по одной кнопке — входит ровно один', async () => {
    const p = await person()
    const url = await botButton(p)
    const results = await Promise.all([press(url), press(url), press(url)])
    expect(results.filter(r => r.sid)).toHaveLength(1)
    expect(results.filter(r => r.redirect === EXPIRED)).toHaveLength(2)
    expect(await sessionsOf(p.id)).toBe(1)
  })

  it('после входа — только путь этого сайта: чужой адрес в «to» ведёт на главную', async () => {
    const p = await person()
    for (const to of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', '/\t/evil.example', 'javascript:alert(1)']) {
      const u = new URL(await botButton(p))
      u.searchParams.set('to', to)
      const r = await press(u.toString())
      expect(r.redirect, to).toBe('/')
      expect(r.sid, to).toBeDefined()
    }
  })

  it('номер чужого уведомления в адресе ничего не отмечает', async () => {
    const a = await person()
    const b = await person()
    const foreign = await sentNotification(b.id)
    expect((await press(await botButton(a, '/learn', foreign))).sid).toBeDefined()
    expect((await admin`select reacted_at from notifications where id = ${foreign}`)[0]!.reacted_at).toBeNull()
  })

  it('частотное ограничение: сверх 60 переходов с адреса за 10 минут — экран «зачекайте», токен не тратится', async () => {
    const p = await person()
    const url = await botButton(p)
    const ip = `${NET}.250`
    await admin`insert into rate_limits (key, count, reset_at) values (${`tg:go:${ip}`}, 60, now() + interval '10 minutes')
      on conflict (key) do update set count = 60, reset_at = excluded.reset_at`
    expect(await press(url, { ip })).toMatchObject({ redirect: '/login?error=tg_too_many', sid: undefined })
    expect((await tokenRow(url))!.consumed_at).toBeNull()
    expect((await press(url)).sid).toBeDefined() // с другого адреса та же кнопка входит
  })

  it('кто уже вошёл в этом браузере, по устаревшей кнопке идёт сразу на страницу — без новой сессии', async () => {
    const p = await person()
    const { token } = await createSession({ tenantId, userId: p.id, loginMethod: 'otp_sms' })
    const url = await botButton(p, '/learn/y')
    await admin`update telegram_tokens set expires_at = now() - interval '1 second' where token_hash = ${sha256(tokenOf(url))}`
    expect(await press(url, { cookie: token })).toMatchObject({ redirect: '/learn/y', sid: undefined })
    // Кнопка старого вида, без токена, — тоже только переход, не вход
    expect(await press(`/tg/go?to=/learn/z&c=${p.chatId}`, { cookie: token })).toMatchObject({ redirect: '/learn/z', sid: undefined })
    expect(await sessionsOf(p.id)).toBe(1)
    // Без сессии в браузере та же кнопка — экран «посилання застаріло»
    expect((await press(url)).redirect).toBe(EXPIRED)
  })
})

describe('/menu присылает свежую кнопку входа (docs/23 §7)', () => {
  it('без активных задач — «Відкрити Lola» с новым токеном; по ней входит', async () => {
    const p = await person()
    sent.length = 0
    await T.handleUpdate({ message: { chat: { id: Number(p.chatId) }, text: '/menu' } })
    const btn = sent.find(m => m.chat_id === String(p.chatId))!.reply_markup!.inline_keyboard[0]![0]!
    expect(btn.text).toBe('Відкрити Lola')
    const r = await press(btn.url!)
    expect(r.redirect).toBe('/')
    expect(await validateSession(r.sid!)).toMatchObject({ tenantId, userId: p.id })
  })
})
