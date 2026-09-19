import { eq, sql } from 'drizzle-orm'
import { smsUsage, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { getSecret, markSecretResult, SECRET_KEYS } from './secrets'

/**
 * SMS и e-mail (docs/06 §6.4): провайдер по API из секретов тенанта.
 * SMS — только OTP и критичное; учёт отправок на тенанта с лимитом тарифа.
 * Без настроенного провайдера — skipped с понятной причиной (docs/09 §9.3).
 */

export type ChannelResult = { ok: true } | { ok: false, skipped: boolean, error: string }

export async function sendViaChannel(tenantId: string, channel: 'sms' | 'email', msg: { userId: string, text: string, subject?: string }): Promise<ChannelResult> {
  const [u] = await withTenant(tenantId, null, tx => tx.select({ phone: users.phone, email: users.email }).from(users).where(eq(users.id, msg.userId)))
  if (channel === 'sms') {
    if (!u?.phone) return { ok: false, skipped: true, error: 'no phone' }
    return sendSms(tenantId, u.phone, msg.text)
  }
  if (!u?.email) return { ok: false, skipped: true, error: 'no email' }
  return sendEmail(tenantId, u.email, msg.subject ?? 'Lola', msg.text)
}

export async function sendSms(tenantId: string, phone: string, text: string): Promise<ChannelResult> {
  const provider = await getSecret(tenantId, 'sms', SECRET_KEYS.sms.PROVIDER)
  const apiKey = await getSecret(tenantId, 'sms', SECRET_KEYS.sms.API_KEY)
  if (!provider || !apiKey) return { ok: false, skipped: true, error: 'sms not configured' }

  // Лимит тарифа на месяц
  const month = new Date().toISOString().slice(0, 7)
  const [tenant] = await (await import('../db/client')).db.execute(sql`select p.max_sms_per_month as lim from tenants t join plans p on p.code = t.plan where t.id = ${tenantId}`) as unknown as { lim: number | null }[]
  const used = await withTenant(tenantId, null, async (tx) => {
    const [r] = await tx.insert(smsUsage).values({ tenantId, month, count: 1 })
      .onConflictDoUpdate({ target: [smsUsage.tenantId, smsUsage.month], set: { count: sql`${smsUsage.count} + 1` } })
      .returning({ count: smsUsage.count })
    return r!.count
  })
  if (tenant?.lim != null && used > tenant.lim) return { ok: false, skipped: true, error: `sms limit ${tenant.lim}/month` }

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

export async function sendEmail(tenantId: string, to: string, subject: string, text: string): Promise<ChannelResult> {
  const url = await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.URL) ?? process.env.SMTP_URL
  const from = await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.FROM) ?? process.env.SMTP_FROM ?? 'lola@localhost'
  if (!url) return { ok: false, skipped: true, error: 'smtp not configured' }
  try {
    const nodemailer = await import('nodemailer')
    const transport = nodemailer.createTransport(url)
    await transport.sendMail({ from, to, subject, text })
    await markSecretResult(tenantId, 'smtp', true)
    return { ok: true }
  }
  catch (err) {
    await markSecretResult(tenantId, 'smtp', false, String(err))
    return { ok: false, skipped: false, error: String(err).slice(0, 200) }
  }
}
