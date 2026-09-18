import { handleUpdate } from '../../../services/telegram'
/** Webhook Telegram. Секрет в пути/заголовке (X-Telegram-Bot-Api-Secret-Token). */
export default defineEventHandler(async (event) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (secret && getHeader(event, 'x-telegram-bot-api-secret-token') !== secret) {
    throw createError({ statusCode: 403, data: { code: 'forbidden', message: 'bad secret' } })
  }
  const update = await readBody(event).catch(() => null)
  if (update && typeof update === 'object') {
    event.waitUntil(handleUpdate(update as Record<string, unknown>).catch(err => console.error('telegram update', err)))
  }
  return { ok: true }
})
