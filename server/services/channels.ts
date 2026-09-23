import { eq, sql } from 'drizzle-orm'
import { smsUsage, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { getSecret, markSecretResult, SECRET_KEYS } from './secrets'
import { meterOrDegrade, recordUsage, type AxisDegradation } from './usageCounters'

/**
 * SMS и e-mail (docs/06 §6.4): провайдер по API из секретов тенанта.
 * SMS — только OTP и критичное; учёт отправок на тенанта с лимитом тарифа.
 * Без настроенного провайдера — skipped с понятной причиной (docs/09 §9.3).
 *
 * Исчерпание оси `sms_out` (docs/v2/35 §7.1) — не ошибка доставки, а **деградация канала**:
 * в ответе появляется `degradation: 'channel_fallback'`, и вызывающий уходит в Telegram и
 * in-app (`23` §6). Уведомление не теряется никогда (правило `25` §10).
 */

export type ChannelResult = { ok: true } | { ok: false, skipped: boolean, error: string, degradation?: AxisDegradation | null }

export async function sendViaChannel(tenantId: string, channel: 'sms' | 'email' | 'push', msg: { userId: string, text: string, subject?: string, html?: string }): Promise<ChannelResult> {
  if (channel === 'push') {
    const { sendPushToUser } = await import('./push')
    return sendPushToUser(tenantId, msg.userId)
  }
  const [u] = await withTenant(tenantId, null, tx => tx.select({ phone: users.phone, email: users.email }).from(users).where(eq(users.id, msg.userId)))
  if (channel === 'sms') {
    if (!u?.phone) return { ok: false, skipped: true, error: 'no phone' }
    return sendSms(tenantId, u.phone, msg.text)
  }
  if (!u?.email) return { ok: false, skipped: true, error: 'no email' }
  return sendEmail(tenantId, u.email, msg.subject ?? 'Lola', msg.text, msg.html)
}

/** Чи налаштований реальний SMS-провайдер тенанта (docs/28 «Вхід: код на e-mail») — для автофолбека OTP на пошту. */
export async function hasSmsProvider(tenantId: string): Promise<boolean> {
  const provider = await getSecret(tenantId, 'sms', SECRET_KEYS.sms.PROVIDER)
  const apiKey = await getSecret(tenantId, 'sms', SECRET_KEYS.sms.API_KEY)
  return !!provider && !!apiKey
}

export async function sendSms(tenantId: string, phone: string, text: string): Promise<ChannelResult> {
  const provider = await getSecret(tenantId, 'sms', SECRET_KEYS.sms.PROVIDER)
  const apiKey = await getSecret(tenantId, 'sms', SECRET_KEYS.sms.API_KEY)
  if (!provider || !apiKey) return { ok: false, skipped: true, error: 'sms not configured' }

  // Ось `sms_out` (docs/v2/35 §7.1): счётчик периода, проверка в момент операции. Решение
  // «пройдёт или нет» принимает общая `meterOrDegrade()` поверх `checkLimit()` из PR-08 —
  // второй формулы квоты здесь нет. При исчерпании канал SMS отключается, доставка идёт
  // Telegram и in-app (`23` §6): уведомление не теряется, обучение не останавливается.
  const gate = await meterOrDegrade(tenantId, 'sms_out')
  if (!gate.allowed) return { ok: false, skipped: true, error: `sms limit ${gate.state.limit}/period`, degradation: gate.degradation }
  // Прежний помесячный счётчик `sms_usage` остаётся: он показывает календарный месяц на
  // экране «Статистика використання», тогда как ось считает биллинговый период (docs/28).
  const month = new Date().toISOString().slice(0, 7)
  await withTenant(tenantId, null, async (tx) => {
    await tx.insert(smsUsage).values({ tenantId, month, count: 1 })
      .onConflictDoUpdate({ target: [smsUsage.tenantId, smsUsage.month], set: { count: sql`${smsUsage.count} + 1` } })
  })
  await recordUsage(tenantId, 'sms_out', 1, { refKind: 'sms', meta: { month } }).catch(() => null)

  try {
    if (provider === 'turbosms') {
      const sender = (await getSecret(tenantId, 'sms', SECRET_KEYS.sms.SENDER)) ?? 'Lola'
      const res = await fetch('https://api.turbosms.ua/message/send.json', {
        method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients: [phone.replace('+', '')], sms: { sender, text } }), signal: AbortSignal.timeout(10_000),
      })
      const json = await res.json() as { response_code?: number, response_status?: string }
      if (json.response_code === 0 || json.response_status === 'OK') { await markSecretResult(tenantId, 'sms', true); return { ok: true } }
      await markSecretResult(tenantId, 'sms', false, json.response_status)
      return { ok: false, skipped: false, error: json.response_status ?? 'sms error' }
    }
    if (provider === 'log') {
      console.log(`[sms:log] ${phone}: ${text}`)
      return { ok: true }
    }
    return { ok: false, skipped: true, error: `unknown sms provider ${provider}` }
  }
  catch (err) {
    await markSecretResult(tenantId, 'sms', false, String(err))
    return { ok: false, skipped: false, error: String(err).slice(0, 200) }
  }
}

/**
 * Транспорт SMTP тенанта (docs/09 §9.7.1): свій host/port/login/password, иначе — старый
 * единый `url` (совместимость) или платформенный `SMTP_URL` (fallback, docs/28 «Spec 23»).
 * Докс/33 D-050 — расширенные поля: SSL (независимо от порта), «Режим відлагодження» (логи
 * nodemailer), «Час затримки повідомлення в черзі» и «Максимальний розмір вкладення» отдаём
 * отдельно от транспорта (их применяет `sendEmail`, а не сам nodemailer); «Ігнорувати помилки
 * TLS» — не тут: ключ платформенный (`PLATFORM_ONLY_KEYS`), читается отдельно ниже.
 */
export interface SmtpConfig {
  transport: string | Record<string, unknown>
  from: string
  queueDelayMs: number
  maxAttachmentMb: number | null
}
export async function smtpTransportConfig(tenantId: string): Promise<SmtpConfig | null> {
  const host = await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.HOST)
  const from = (await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.FROM_EMAIL)) ?? (await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.FROM)) ?? process.env.SMTP_FROM ?? 'lola@localhost'
  const fromName = await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.FROM_NAME)
  const fromHeader = fromName ? `"${fromName.replace(/"/g, '')}" <${from}>` : from
  const queueDelayMs = Number(await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.QUEUE_DELAY_MS)) || 0
  const maxAttachmentMbRaw = await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.MAX_ATTACHMENT_MB)
  const maxAttachmentMb = maxAttachmentMbRaw ? Number(maxAttachmentMbRaw) : null
  const ssl = (await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.SSL)) === 'true'
  const debugMode = (await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.DEBUG_MODE)) === 'true'
  // docs/09 §9.7.1 п. 3: значення ставить лише оператор платформи (`PLATFORM_ONLY_KEYS`), але сам
  // рядок лежить у тій самій `tenant_secrets` — читаємо звичайним `getSecret`, без BYPASSRLS
  const ignoreTlsErrors = (await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.IGNORE_TLS_ERRORS)) === 'true'
  if (host) {
    const port = Number(await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.PORT)) || 587
    const login = await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.LOGIN)
    const password = await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.PASSWORD)
    return {
      transport: {
        host, port, secure: ssl || port === 465, auth: login ? { user: login, pass: password ?? '' } : undefined,
        ...(ignoreTlsErrors ? { tls: { rejectUnauthorized: false } } : {}),
        ...(debugMode ? { logger: true, debug: true } : {}),
      },
      from: fromHeader,
      queueDelayMs,
      maxAttachmentMb,
    }
  }
  const url = (await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.URL)) ?? process.env.SMTP_URL
  if (!url) return null
  return { transport: url, from: fromHeader, queueDelayMs, maxAttachmentMb }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export async function sendEmail(tenantId: string, to: string, subject: string, text: string, html?: string, attachmentBytes?: number): Promise<ChannelResult> {
  const cfg = await smtpTransportConfig(tenantId)
  if (!cfg) return { ok: false, skipped: true, error: 'smtp not configured' }
  // «Максимальний розмір вкладення» (docs/09 §9.7.1) — відсічка на боці відправника, до спроби з'єднання
  if (attachmentBytes != null && cfg.maxAttachmentMb != null && attachmentBytes > cfg.maxAttachmentMb * 1024 * 1024) {
    return { ok: false, skipped: true, error: `attachment too large: limit ${cfg.maxAttachmentMb} MB` }
  }
  // «Час затримки повідомлення в черзі» (docs/09 §9.7.1) — щоб провайдер не прийняв розсилку за спам
  if (cfg.queueDelayMs > 0) await sleep(cfg.queueDelayMs)
  const replyTo = await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.REPLY_TO)
  try {
    const nodemailer = await import('nodemailer')
    const transport = nodemailer.createTransport(cfg.transport as never)
    await transport.sendMail({ from: cfg.from, to, subject, text, ...(html ? { html } : {}), ...(replyTo ? { replyTo } : {}) })
    await markSecretResult(tenantId, 'smtp', true)
    return { ok: true }
  }
  catch (err) {
    await markSecretResult(tenantId, 'smtp', false, String(err))
    return { ok: false, skipped: false, error: String(err).slice(0, 200) }
  }
}

/** «Надіслати тестове повідомлення» (docs/09 §9.7.1): перевірка з'єднання без постановки в чергу. */
export async function testSmtpConnection(tenantId: string, to: string): Promise<ChannelResult> {
  return sendEmail(tenantId, to, 'Lola — перевірка SMTP', 'Це тестовий лист. Якщо ви його бачите — SMTP налаштовано правильно.')
}
