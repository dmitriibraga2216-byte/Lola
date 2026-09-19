import { createHash, randomBytes } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { telegramTokens, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { enqueueNotification } from './notifications'
import { createSession } from './session'
import { logSecurity } from './securityLog'

/**
 * Telegram-бот (docs/04 §4.12, docs/06 §6.4): один бот на платформу,
 * привязка chat_id по одноразовому токену, кнопки под уведомлением,
 * автологин по ссылке. Обучение в чате не ведётся.
 */

const API = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`
const botEnabled = () => !!process.env.TELEGRAM_BOT_TOKEN

export interface SendResult { ok: boolean, blocked?: boolean, error?: string }

/** sendMessage с inline-кнопками «Пройти». Без токена — заглушка в лог (dev/CI). */
export async function sendTelegram(chatId: bigint, text: string, opts?: { enrollmentId?: string }): Promise<SendResult> {
  if (!botEnabled()) {
    console.log(`[telegram:stub] chat ${chatId}: ${text}`)
    return { ok: true }
  }
  const appUrl = process.env.APP_URL || 'http://localhost:3000'
  const body: Record<string, unknown> = { chat_id: String(chatId), text, parse_mode: 'HTML' }
  if (opts?.enrollmentId) {
    body.reply_markup = {
      inline_keyboard: [[
        { text: 'Пройти', url: `${appUrl}/tg/go?e=${opts.enrollmentId}&c=${chatId}` },
        { text: 'Відкласти на день', callback_data: `snooze:${opts.enrollmentId}` },
      ]],
    }
  }
  try {
    const res = await fetch(`${API()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    const json = await res.json() as { ok: boolean, error_code?: number, description?: string }
    if (json.ok) return { ok: true }
    if (json.error_code === 403) return { ok: false, blocked: true, error: json.description }
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
  const bot = process.env.TELEGRAM_BOT_USERNAME
  return { token, url: bot ? `https://t.me/${bot}?start=${token}` : null }
}

interface TokenRow { token_id: string, tenant_id: string, user_id: string, kind: string, expires_at: string, consumed_at: string | null }

/** /start <token> → привязать chat_id. Идёт до контекста тенанта — через SECURITY DEFINER. */
export async function linkChat(token: string, chatId: bigint): Promise<{ ok: boolean, fullName?: string }> {
  const rows = await db.execute(sql`select * from telegram_token_lookup(${hash(token)})`)
  const row = (rows as unknown as TokenRow[])[0]
  if (!row || row.kind !== 'link' || row.consumed_at || new Date(row.expires_at) < new Date()) return { ok: false }

  const fullName = await withTenant(row.tenant_id, row.user_id, async (tx) => {
    await tx.update(telegramTokens).set({ consumedAt: new Date() }).where(eq(telegramTokens.id, row.token_id))
    const [u] = await tx.update(users).set({ telegramChatId: chatId }).where(eq(users.id, row.user_id)).returning({ fullName: users.fullName })
    await enqueueNotification(tx, { tenantId: row.tenant_id, userId: row.user_id, code: 'telegram_linked', payload: {}, urgent: true })
    return u!.fullName
  })
  await logSecurity({ tenantId: row.tenant_id, userId: row.user_id, event: 'telegram.linked', meta: { chatId: String(chatId) } })
  return { ok: true, fullName }
}

/** Автологин по ссылке из бота: одноразовый токен 10 минут, привязан к chat_id. */
export async function createLoginToken(chatId: bigint): Promise<{ token: string, tenantId: string } | null> {
  const rows = await db.execute(sql`select * from telegram_chat_lookup(${chatId})`)
  const row = (rows as unknown as { tenant_id: string, user_id: string }[])[0]
  if (!row) return null
  const token = randomBytes(24).toString('base64url')
  await withTenant(row.tenant_id, row.user_id, async (tx) => {
    await tx.insert(telegramTokens).values({
      tenantId: row.tenant_id, userId: row.user_id, kind: 'login',
      tokenHash: hash(token), expiresAt: new Date(Date.now() + 10 * 60_000),
    })
  })
  return { token, tenantId: row.tenant_id }
}

export async function consumeLoginToken(token: string, meta: { userAgent?: string | null, ip?: string | null }): Promise<{ sessionToken: string } | null> {
  const rows = await db.execute(sql`select * from telegram_token_lookup(${hash(token)})`)
  const row = (rows as unknown as TokenRow[])[0]
  if (!row || row.kind !== 'login' || row.consumed_at || new Date(row.expires_at) < new Date()) return null
  await withTenant(row.tenant_id, row.user_id, async (tx) => {
    await tx.update(telegramTokens).set({ consumedAt: new Date() }).where(eq(telegramTokens.id, row.token_id))
  })
  const { token: sessionToken } = await createSession({ tenantId: row.tenant_id, userId: row.user_id, userAgent: meta.userAgent, ip: meta.ip })
  await logSecurity({ tenantId: row.tenant_id, userId: row.user_id, event: 'login.telegram', ip: meta.ip })
  return { sessionToken }
}

/** Обработка апдейта от Telegram (webhook). */
export async function handleUpdate(update: Record<string, unknown>): Promise<void> {
  const msg = update.message as { chat?: { id: number }, text?: string } | undefined
  if (msg?.chat?.id && msg.text?.startsWith('/start')) {
    const token = msg.text.split(' ')[1]
    const chatId = BigInt(msg.chat.id)
    if (!token) {
      await sendTelegram(chatId, 'Щоб підключити Telegram, відкрий Lola → Профіль → «Підключити Telegram» і перейди за посиланням.')
      return
    }
    const r = await linkChat(token, chatId)
    await sendTelegram(chatId, r.ok ? `Готово, ${r.fullName}! Сюди приходитимуть нагадування.` : 'Посилання протухло або вже використане. Отримай нове в Lola.')
    return
  }
  const cb = update.callback_query as { id: string, data?: string, message?: { chat: { id: number } } } | undefined
  if (cb?.data?.startsWith('snooze:') && botEnabled()) {
    await fetch(`${API()}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: cb.id, text: 'Нагадаю завтра' }),
    }).catch(() => {})
  }
}
