import { eq, sql } from 'drizzle-orm'
import { smsUsage, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { getSecret, markSecretResult, SECRET_KEYS } from './secrets'
import { effectiveLimits } from './tenantLimits'

/**
 * SMS и e-mail (docs/06 §6.4): провайдер по API из секретов тенанта.
 * SMS — только OTP и критичное; учёт отправок на тенанта с лимитом тарифа.
 * Без настроенного провайдера — skipped с понятной причиной (docs/09 §9.3).
 */

export type ChannelResult = { ok: true } | { ok: false, skipped: boolean, error: string }

export async function sendViaChannel(tenantId: string, channel: 'sms' | 'email', msg: { userId: string, text: string, subject?: string, html?: string }): Promise<ChannelResult> {
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

  // Лимит SMS в месяц: переопределение тенанта (`tenant_limits.smsPerMonth`), иначе — тариф (docs/25 §10, докс/33 D-054/D-055)
  const month = new Date().toISOString().slice(0, 7)
  const lim = (await effectiveLimits(tenantId)).smsPerMonth
  const used = await withTenant(tenantId, null, async (tx) => {
    const [r] = await tx.insert(smsUsage).values({ tenantId, month, count: 1 })
      .onConflictDoUpdate({ target: [smsUsage.tenantId, smsUsage.month], set: { count: sql`${smsUsage.count} + 1` } })
      .returning({ count: smsUsage.count })
    return r!.count
  })
  if (lim != null && used > lim) return { ok: false, skipped: true, error: `sms limit ${lim}/month` }

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
 */
export async function smtpTransportConfig(tenantId: string): Promise<{ transport: string | Record<string, unknown>, from: string } | null> {
  const host = await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.HOST)
  const from = (await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.FROM_EMAIL)) ?? (await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.FROM)) ?? process.env.SMTP_FROM ?? 'lola@localhost'
  const fromName = await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.FROM_NAME)
  const fromHeader = fromName ? `"${fromName.replace(/"/g, '')}" <${from}>` : from
  if (host) {
    const port = Number(await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.PORT)) || 587
    const login = await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.LOGIN)
    const password = await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.PASSWORD)
    return {
      transport: { host, port, secure: port === 465, auth: login ? { user: login, pass: password ?? '' } : undefined },
      from: fromHeader,
    }
  }
  const url = (await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.URL)) ?? process.env.SMTP_URL
  if (!url) return null
  return { transport: url, from: fromHeader }
}

export async function sendEmail(tenantId: string, to: string, subject: string, text: string, html?: string): Promise<ChannelResult> {
  const cfg = await smtpTransportConfig(tenantId)
  if (!cfg) return { ok: false, skipped: true, error: 'smtp not configured' }
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
