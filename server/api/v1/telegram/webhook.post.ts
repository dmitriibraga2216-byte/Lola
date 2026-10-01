import { timingSafeEqual } from 'node:crypto'
import { handleUpdate } from '../../../services/telegram'

/**
 * Webhook Telegram. Секрет — в заголовке `X-Telegram-Bot-Api-Secret-Token` (его задаёт `setWebhook`
 * параметром `secret_token`). Без `TELEGRAM_WEBHOOK_SECRET` webhook закрыт (security-sweep-1): иначе любой
 * мог прислать «update» с чужим `chat.id` — отписать человека от уведомлений или привязать к его чату
 * чужую учётку.
 */
export default defineEventHandler(async (event) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  const got = Buffer.from(getHeader(event, 'x-telegram-bot-api-secret-token') ?? '')
  if (!secret || got.length !== Buffer.byteLength(secret) || !timingSafeEqual(got, Buffer.from(secret))) {
    if (!secret) console.error('[telegram] TELEGRAM_WEBHOOK_SECRET не задан — webhook отклоняет все запросы')
    throw createError({ statusCode: 403, data: { code: 'forbidden', message: 'bad secret' } })
  }
  const update = await readBody(event).catch(() => null)
  if (update && typeof update === 'object') {
    event.waitUntil(handleUpdate(update as Record<string, unknown>).catch(err => console.error('telegram update', err)))
  }
  return { ok: true }
})
