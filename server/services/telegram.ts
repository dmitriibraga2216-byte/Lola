import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { telegramTokens, users } from '../db/schema'
import type { TwoFactorStep } from '../../shared/domain/twoFactor'
import { withTenant } from '../utils/withTenant'
import { enqueueNotification } from './notifications'
import { createSession } from './session'
import { logSecurity } from './securityLog'
import { getSecret, SECRET_KEYS } from './secrets'
import { frameJoins, frameSelect } from './reportFrame'
import { EMPLOYEES_ONLY, personById } from './repo/people'

/**
 * Telegram-бот (docs/04 §4.12, docs/06 §6.4; docs/09 §9.7.2, Spec 23): токен бота —
 * атрибут тенанта (свій бот), «External Telegram Bot Token» — запасний зовнішній бот,
 * коли тенант свого не завів; платформенний `TELEGRAM_BOT_TOKEN` лишається останнім
 * фолбеком (dev/демо-стенд без жодного налаштованого тенанта). Вхідний webhook — один
 * на платформу: `chat_id` в Telegram унікальний для людини незалежно від бота, тож
 * прив'язка за `chat_id` працює, навіть якщо тенант вебхук свого бота теж наведе сюди
 * (docs/28 «Spec 23» — довг: окремий webhook-роутинг на бота не робили).
 */

/** Токен бота для тенанта: свій → зовнішній → платформенний (docs/09 §9.7.2). */
export async function botTokenFor(tenantId: string | null): Promise<string | undefined> {
  if (tenantId) {
    const own = await getSecret(tenantId, 'telegram', SECRET_KEYS.telegram.BOT_TOKEN)
    if (own) return own
    const ext = await getSecret(tenantId, 'telegram', SECRET_KEYS.telegram.EXTERNAL_BOT_TOKEN)
    if (ext) return ext
  }
  return process.env.TELEGRAM_BOT_TOKEN
}

const API = (token: string | undefined) => `https://api.telegram.org/bot${token}`
/** Подмена HTTP для тестов (как setOAuthHttp). */
let http: typeof fetch = (...args) => fetch(...args)
export function setTelegramHttp(f: typeof fetch | null) { http = f ?? ((...args) => fetch(...args)) }

export interface SendResult { ok: boolean, blocked?: boolean, error?: string }

/** Срок кнопки входа из бота (docs/23 §6 п. 7, docs/04 §4.19): 10 минут с момента отправки сообщения. */
export const BOT_LOGIN_TTL_MINUTES = 10

/** sendMessage с inline-кнопками «Пройти». Без токена бота — заглушка в лог (dev/CI). */
export interface SendOpts {
  enrollmentId?: string
  url?: string | null
  /** Подпись кнопки со ссылкой, по умолчанию «Пройти». */
  urlText?: string
  /**
   * Адресат сообщения. Кнопка входа выпускается на него в момент отправки (docs/23 §6 п. 7);
   * без адресата кнопка — обычная ссылка, и войти придётся кодом.
   */
  userId?: string
  notificationId?: string
  buttons?: { text: string, action: string }[]
  mandatory?: boolean
}

const appUrl = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
const linkOf = (opts: SendOpts) => opts.url ?? (opts.enrollmentId ? `/learn/${opts.enrollmentId}` : null)

/** Адрес кнопки входа: `/tg/go?t=<токен>&to=<путь>[&n=<уведомление>]` (docs/23 §6 п. 7). */
export function botLoginUrl(token: string, to: string, notificationId?: string): string {
  const q = new URLSearchParams({ t: token, to })
  if (notificationId) q.set('n', notificationId)
  return `${appUrl()}/tg/go?${q}`
}

/**
 * Кнопки под уведомлением (docs/23 §7): «Пройти» (вход по одноразовому токену), «Відкласти на день»
 * (до двух раз), «Не нагадувати» (только необязательные). `loginToken` — токен, выпущенный для этого
 * сообщения (`issueLoginToken`); без него «Пройти» ведёт на страницу напрямую, через обычный вход.
 */
export function keyboardFor(opts: SendOpts, loginToken: string | null): unknown {
  const row: Record<string, unknown>[] = []
  const url = linkOf(opts)
  if (url) row.push({ text: opts.urlText ?? 'Пройти', url: loginToken ? botLoginUrl(loginToken, url, opts.notificationId) : `${appUrl()}${url}` })
  if (opts.notificationId) row.push({ text: 'Відкласти на день', callback_data: `snooze:${opts.notificationId}` })
  if (opts.notificationId && !opts.mandatory) row.push({ text: 'Не нагадувати про це', callback_data: `mute:${opts.notificationId}` })
  for (const b of opts.buttons ?? []) row.push(b.action.startsWith('http') ? { text: b.text, url: b.action } : { text: b.text, callback_data: b.action.slice(0, 60) })
  return row.length ? { inline_keyboard: [row.slice(0, 3)] } : undefined
}

export async function sendTelegram(tenantId: string | null, chatId: bigint, text: string, opts?: SendOpts): Promise<SendResult> {
  const token = await botTokenFor(tenantId)
  if (!token) {
    console.log(`[telegram:stub] chat ${chatId}: ${text}`)
    return { ok: true }
  }
  const body: Record<string, unknown> = { chat_id: String(chatId), text, parse_mode: 'HTML' }
  // Токен кнопки входа выпускается здесь — в момент отправки, на адресата этого сообщения (docs/23 §6 п. 7)
  const loginToken = opts?.userId && tenantId && linkOf(opts) ? await issueLoginToken(tenantId, opts.userId) : null
  const kb = opts ? keyboardFor(opts, loginToken) : undefined
  if (kb) body.reply_markup = kb
  try {
    const res = await http(`${API(token)}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    const json = await res.json() as { ok: boolean, error_code?: number, description?: string }
    if (json.ok) {
      // Ось `telegram_out` (docs/v2/35 §7.1) — мягкая: канал бесплатный, лимита у неё нет ни
      // в тарифе, ни у тенанта, и доставка не останавливается никогда. Счётчик ведётся только
      // ради наблюдения: всплеск — признак ошибки в правилах рассылки.
      if (tenantId) {
        const { recordUsage } = await import('./usageCounters')
        await recordUsage(tenantId, 'telegram_out', 1).catch(() => null)
      }
      return { ok: true }
    }
    if (json.error_code === 403) return { ok: false, blocked: true, error: json.description }
    if (json.error_code === 400 && /chat not found/i.test(json.description ?? '')) return { ok: false, blocked: true, error: json.description } // §7: сброс привязки
    if (json.error_code === 429) return { ok: false, error: `rate_limited retry_after=${(json as { parameters?: { retry_after?: number } }).parameters?.retry_after ?? 5}` }
    return { ok: false, error: json.description ?? `HTTP ${res.status}` }
  }
  catch (err) {
    return { ok: false, error: String(err) }
  }
}

function hash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

/** Ссылка привязки: t.me/<bot>?start=<token>, токен 15 минут (docs/04 §4.12). */
export async function createLinkToken(ctx: { tenantId: string, actorId: string }): Promise<{ token: string, url: string | null }> {
  const token = randomBytes(16).toString('base64url')
  await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    await tx.insert(telegramTokens).values({
      tenantId: ctx.tenantId,
      userId: ctx.actorId,
      kind: 'link',
      tokenHash: hash(token),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    })
  })
  const bot = (await getSecret(ctx.tenantId, 'telegram', SECRET_KEYS.telegram.BOT_USERNAME)) ?? process.env.TELEGRAM_BOT_USERNAME
  return { token, url: bot ? `https://t.me/${bot}?start=${token}` : null }
}

interface TokenRow { token_id: string, tenant_id: string, user_id: string, kind: string, expires_at: string, consumed_at: string | null }

/** /start <token> → привязать chat_id. Идёт до контекста тенанта — через SECURITY DEFINER. */
export async function linkChat(token: string, chatId: bigint): Promise<{ ok: boolean, fullName?: string, tenantId?: string }> {
  const rows = await db.execute(sql`select * from telegram_token_lookup(${hash(token)})`)
  const row = (rows as unknown as TokenRow[])[0]
  if (!row || row.kind !== 'link' || row.consumed_at || new Date(row.expires_at) < new Date()) return { ok: false }

  const fullName = await withTenant(row.tenant_id, row.user_id, async (tx) => {
    await tx.update(telegramTokens).set({ consumedAt: new Date() }).where(eq(telegramTokens.id, row.token_id))
    const [u] = await tx.update(users).set({ telegramChatId: chatId, telegramBlocked: false }).where(eq(users.id, row.user_id)).returning({ fullName: users.fullName })
    await enqueueNotification(tx, { tenantId: row.tenant_id, userId: row.user_id, code: 'telegram_linked', payload: {}, urgent: true })
    return u!.fullName
  })
  await logSecurity({ tenantId: row.tenant_id, userId: row.user_id, event: 'contacts.changed', meta: { field: 'telegram', chatId: String(chatId) } })
  return { ok: true, fullName, tenantId: row.tenant_id }
}

/**
 * Токен кнопки входа (docs/23 §6 п. 7, docs/04 §4.19). Выпускается в момент, когда бот отправляет
 * сообщение конкретному человеку, и уходит только в ссылку этого сообщения. Одноразовый, живёт
 * `BOT_LOGIN_TTL_MINUTES`, в базе — только sha256-хеш (как коды OTP), привязан к человеку и пространству.
 */
export async function issueLoginToken(tenantId: string, userId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url')
  await withTenant(tenantId, userId, async (tx) => {
    await tx.insert(telegramTokens).values({
      tenantId, userId, kind: 'login',
      tokenHash: hash(token), expiresAt: new Date(Date.now() + BOT_LOGIN_TTL_MINUTES * 60_000),
    })
  })
  return token
}

/** Экран отказа кнопки входа: один на все причины, текст — «Посилання застаріло, попросіть у бота нове». */
export const BOT_LINK_EXPIRED_REDIRECT = '/login?error=tg_link_expired'

/** Итог перехода по кнопке входа. Отказ один на все причины — маршрут показывает на него один экран. */
export type BotLoginResult =
  | { ok: true, tenantId: string, userId: string, sessionToken: string, twoFactor: TwoFactorStep | null }
  | { ok: false }

/**
 * Переход по кнопке входа из бота (`GET /tg/go`). Отказ — неизвестный, просроченный или уже
 * использованный токен; токен другого пространства на хосте пространства; человек, который
 * больше не может войти через бота (не активен, заблокирован, Telegram отвязан). Токен гасится
 * атомарно и до создания сессии: из двух одновременных переходов по одной кнопке входит один.
 * Сессию создаёт `createSession()` — со всеми её проверками (закрытое пространство, форма входа,
 * второй фактор, …); её отказ пробрасывается как есть, токен при этом уже потрачен.
 */
export async function consumeLoginToken(token: string, meta: { userAgent?: string | null, ip?: string | null, hostTenantId?: string | null }): Promise<BotLoginResult> {
  // До контекста тенанта — только функция SECURITY DEFINER (правило контура, docs/27 §27.8.1 п. 2)
  const rows = await db.execute(sql`select * from telegram_token_lookup(${hash(token)})`)
  const row = (rows as unknown as TokenRow[])[0]
  if (!row || row.kind !== 'login' || row.consumed_at || new Date(row.expires_at) <= new Date()) return { ok: false }
  // На хосте пространства входят только в него (docs/25 §16.1): чужой токен здесь не действует и не тратится
  if (meta.hostTenantId && meta.hostTenantId !== row.tenant_id) return { ok: false }
  const usable = await withTenant(row.tenant_id, row.user_id, async (tx) => {
    const [spent] = await tx.update(telegramTokens).set({ consumedAt: new Date() })
      .where(and(eq(telegramTokens.id, row.token_id), eq(telegramTokens.kind, 'login'), isNull(telegramTokens.consumedAt), gt(telegramTokens.expiresAt, new Date())))
      .returning({ id: telegramTokens.id })
    if (!spent) return false
    // Право войти через бота — на момент перехода, а не отправки; поиск идёт под RLS пространства
    // токена, так что человек из другого пространства здесь не найдётся
    const [person] = await personById(tx, { status: users.status, isBlocked: users.isBlocked, chatId: users.telegramChatId }, row.user_id)
    return Boolean(person && person.status === 'active' && !person.isBlocked && person.chatId !== null)
  })
  if (!usable) return { ok: false }
  const { token: sessionToken, twoFactor } = await createSession({ tenantId: row.tenant_id, userId: row.user_id, userAgent: meta.userAgent, ip: meta.ip, loginMethod: 'otp_telegram' })
  // Второй фактор (docs/24 §3.4): вход завершит код — `login.success` пишется тогда
  if (!twoFactor) await logSecurity({ tenantId: row.tenant_id, userId: row.user_id, event: 'login.success', meta: { method: 'telegram' }, ip: meta.ip })
  return { ok: true, tenantId: row.tenant_id, userId: row.user_id, sessionToken, twoFactor }
}

const HELP = `Команди: /menu — мої завдання і свіже посилання для входу, /stop — вимкнути необовʼязкові нагадування, /help — довідка. Навчання проходиться у вебі: натискайте «Пройти» під повідомленням — кнопка діє ${BOT_LOGIN_TTL_MINUTES} хвилин.`

/** Обработка апдейта от Telegram (webhook): /start, /menu, /help, /stop, кнопки (docs/23 §7). */
export async function handleUpdate(update: Record<string, unknown>): Promise<void> {
  const msg = update.message as { chat?: { id: number }, text?: string } | undefined
  if (msg?.chat?.id && msg.text && !msg.text.startsWith('/start')) {
    const chatId = BigInt(msg.chat.id)
    const cmd = msg.text.trim().split(/\s+/)[0]!.toLowerCase()
    const who = (await db.execute(sql`select * from telegram_chat_lookup(${chatId})`) as unknown as { tenant_id: string, user_id: string }[])[0]
    if (cmd === '/help') { await sendTelegram(null, chatId, HELP); return }
    if (!who) { await sendTelegram(null, chatId, 'Цей чат не привʼязано. Відкрийте Lola → Профіль → «Підключити Telegram».'); return }
    if (cmd === '/menu') {
      const rows = await withTenant(who.tenant_id, who.user_id, tx => tx.execute(sql`
        select e.id, coalesce(c.title, '') as title, e.due_at, e.progress_pct from enrollments e left join courses c on c.id = e.subject_id
        where e.user_id = ${who.user_id}::uuid and e.cancelled_at is null and e.status in ('not_started','in_progress') order by e.due_at nulls last limit 5`)) as unknown as { id: string, title: string, due_at: string | null, progress_pct: number }[]
      const text = rows.length ? `Мої завдання:\n${rows.map((r, i) => `${i + 1}. ${r.title} — ${r.progress_pct}%${r.due_at ? ` (до ${String(r.due_at).slice(0, 10)})` : ''}`).join('\n')}` : 'Активних завдань немає 🎉'
      // Свежая кнопка входа на каждый /menu (docs/23 §6 п. 7): ею человек заменяет просроченную
      await sendTelegram(who.tenant_id, chatId, text, rows[0] ? { url: `/learn/${rows[0].id}`, userId: who.user_id } : { url: '/', urlText: 'Відкрити Lola', userId: who.user_id })
      return
    }
    if (cmd === '/stop') {
      const { listPrefs, setPref } = await import('./notifications')
      const ctx = { tenantId: who.tenant_id, actorId: who.user_id }
      const prefs = await listPrefs(ctx)
      let n = 0
      for (const p of prefs) if (!p.isMandatory && p.enabled) { await setPref(ctx, { code: p.code, enabled: false }); n++ }
      await sendTelegram(who.tenant_id, chatId, `Вимкнено необовʼязкових нагадувань: ${n}. Обовʼязкові (дедлайни, атестації) залишаться. Увімкнути назад можна в Lola → Профіль → Сповіщення.`)
      return
    }
    await sendTelegram(who.tenant_id, chatId, HELP)
    return
  }
  if (msg?.chat?.id && msg.text?.startsWith('/start')) {
    const token = msg.text.split(' ')[1]
    const chatId = BigInt(msg.chat.id)
    if (!token) {
      await sendTelegram(null, chatId, 'Щоб підключити Telegram, відкрий Lola → Профіль → «Підключити Telegram» і перейди за посиланням.')
      return
    }
    const r = await linkChat(token, chatId)
    await sendTelegram(r.tenantId ?? null, chatId, r.ok ? `Готово, ${r.fullName}! Сюди приходитимуть нагадування.` : 'Посилання протухло або вже використане. Отримай нове в Lola.')
    return
  }
  const cb = update.callback_query as { id: string, data?: string, message?: { chat: { id: number } } } | undefined
  if (cb?.data && cb.message?.chat?.id) {
    const answer = async (text: string) => { const tok = await botTokenFor(who?.tenant_id ?? null); if (tok) await fetch(`${API(tok)}/answerCallbackQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: cb.id, text }) }).catch(() => {}) }
    const chatId = BigInt(cb.message.chat.id)
    const who = (await db.execute(sql`select * from telegram_chat_lookup(${chatId})`) as unknown as { tenant_id: string, user_id: string }[])[0]
    if (!who) { await answer('Чат не привʼязано'); return }
    const [kind, id] = cb.data.split(':')
    const { snooze, mute } = await import('./notificationActions')
    if (kind === 'snooze' && id) { const r = await snooze(who.tenant_id, who.user_id, id); await answer(r === 'ok' ? 'Нагадаю завтра' : r === 'limit' ? 'Відкладати можна не більше двох разів' : 'Не знайдено') }
    else if (kind === 'mute' && id) { const r = await mute(who.tenant_id, who.user_id, id); await answer(r === 'ok' ? 'Більше не нагадуватиму про це' : r === 'mandatory' ? 'Це сповіщення не можна вимкнути' : 'Не знайдено') }
    else await answer('')
  }
}

/**
 * telegram.health (docs/23 §10): раз в час getMe; результат — в метрики и лог.
 * Перевіряє платформенний бот (env); перевірка бота кожного тенанта — довг (docs/28 «Spec 23»).
 */
let lastHealth: { ok: boolean, at: Date, error?: string } | null = null
export async function telegramHealth(): Promise<{ ok: boolean, error?: string } | null> {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null
  try {
    const res = await fetch(`${API(process.env.TELEGRAM_BOT_TOKEN)}/getMe`, { signal: AbortSignal.timeout(8_000) })
    const json = await res.json() as { ok: boolean, description?: string }
    lastHealth = { ok: json.ok, at: new Date(), error: json.ok ? undefined : json.description }
  }
  catch (err) { lastHealth = { ok: false, at: new Date(), error: String(err) } }
  if (!lastHealth.ok) console.error('[telegram.health]', lastHealth.error)
  return lastHealth
}
export const telegramHealthState = () => lastHealth

export interface TelegramConnectionRow {
  user_id: string
  full_name: string
  user_status: string
  position: string | null
  city: string | null
  unit: string | null
  location: string | null
  tags: string[]
  connected: boolean
  blocked: boolean
}

/**
 * Список підключень Telegram (docs/28 «Spec 22» отк. (4), D-003): статус `telegram_chat_id`/
 * `telegram_blocked` по кожній активній людині — вкладка «Telegram» журналу сесій (`/admin/journals`).
 * Живий знімок стану, не журнал подій — тому окремий запит, а не через `logs.ts`/`LOG_KINDS`
 * (там записи незмінні й чистяться за строком зберігання, тут — поточний стан `users`).
 */
export async function listTelegramConnections(ctx: { tenantId: string, actorId: string }): Promise<TelegramConnectionRow[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.execute(sql`
      select ${frameSelect()}, (u.telegram_chat_id is not null) as connected, u.telegram_blocked as blocked
      from users u ${frameJoins()}
      where u.status <> 'archived' ${EMPLOYEES_ONLY()}
      order by connected desc, u.full_name
    `) as unknown as Promise<TelegramConnectionRow[]>
  })
}
