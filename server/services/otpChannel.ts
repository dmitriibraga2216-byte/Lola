import { withTenant } from '../utils/withTenant'
import { sendEmail, type ChannelResult } from './channels'
import { readSettings } from './settings'
import { tenantOverrides } from './translations'
import { resolveLocale } from '../../shared/domain/dateFormat'

/**
 * Доставка OTP. Этап 1 (docs/07-stages.md): Telegram + SMS-заглушка в логе.
 * Реальные провайдеры подключаются в этапе 4 (Telegram-бот) без смены интерфейса.
 *
 * docs/28 «Вхід: код на e-mail» — другий канал: лист іде одразу (OTP у чергу не потрапляє —
 * `notifications.ts#BYPASS_DAILY_LIMIT`), через той самий `sendEmail` (SMTP тенанта → платформенний,
 * `server/services/channels.ts`), шаблон `otp_code` (scope global, `notifications.ts#DEFAULT_TEMPLATES`).
 */
export type OtpChannel = 'telegram' | 'sms' | 'email'

const DEFAULT_OTP_SUBJECT = '{{#_tr}}Код для входу до Lola{{/_tr}}'
/** «Код крупно» (докс/28): проста mjml-підмножина (server/services/emailRender.ts) — великий моноширинний код. */
const DEFAULT_OTP_MJML = '<mj-text>{{#_tr}}Ваш код для входу{{/_tr}}</mj-text>'
  + '<mj-text><div style="font-size:36px;font-weight:800;letter-spacing:0.3em;text-align:center;color:#0C0F14">{{code}}</div></mj-text>'
  + '<mj-text>{{#_tr}}Дійсний{{/_tr}} {{minutes}} {{#_tr}}хв. Нікому не повідомляйте цей код.{{/_tr}}</mj-text>'

/** Маска адреси для екрана входу і журналу безпеки (docs/28): `d***@gmail.com`. */
export function maskEmail(email: string): string {
  const [user, domain] = email.split('@')
  if (!user || !domain) return email
  const masked = user.length <= 1 ? user : `${user[0]}${'*'.repeat(user.length - 1)}`
  return `${masked}@${domain}`
}

/** Лист із кодом: шаблон тенанта (custom) або дефолт (global) — обидва редагуються з /admin/settings/notifications. */
export async function sendOtpEmail(tenantId: string, email: string, code: string, ttlMinutes: number, locale: string): Promise<ChannelResult> {
  return withTenant(tenantId, null, async (tx) => {
    const { templateFor, renderTemplate } = await import('./notifications')
    const { buildEmailHtml } = await import('./emailRender')
    // Нормалізована локаль (докс/28, долг PR-107): раніше тут було `locale === 'en' ? 'en' : 'uk'`,
    // яке мовчки губило `ru` — тепер той самий resolveLocale(), що і в датах нижче.
    const loc = resolveLocale(locale)
    const tpl = await templateFor(tx, tenantId, 'otp_code', 'email', loc)
    if (!tpl) return { ok: false, skipped: true, error: 'template disabled' }
    const settings = await readSettings(tx, tenantId)
    const trMap = await tenantOverrides(tenantId, loc)
    const tr = (phrase: string) => trMap[phrase] ?? phrase
    const vars = { code, minutes: ttlMinutes }
    const text = renderTemplate(tpl.body, vars, tr, loc)
    const subject = renderTemplate(tpl.subject ?? DEFAULT_OTP_SUBJECT, vars, tr, loc)
    const mjmlSrc = tpl.bodyMjml ?? (tpl.scope === 'global' ? DEFAULT_OTP_MJML : null)
    const html = buildEmailHtml({
      bodyMjml: mjmlSrc ? renderTemplate(mjmlSrc, vars, tr, loc) : null,
      fallbackText: text,
      layout: { headerMjml: settings.emailLayout.headerMjml, footerMjml: settings.emailLayout.footerMjml },
    })
    return sendEmail(tenantId, email, subject, text, html)
  })
}

/**
 * `target` — телефон для telegram/sms, e-mail для email. SMS/Telegram лишаються стабом
 * (допустимо тільки до підключення каналу, docs/26 §26.6) — код завжди йде в лог, помилок не буває
 * (`{ ok: true }`). E-mail — реальна доставка; результат повертається, щоб викликач (`otp.ts`) міг
 * тихо підстрахуватися SMS-стабом, якщо SMTP тенанта й платформи водночас не налаштовані —
 * код не повинен губитися мовчки.
 */
export async function deliverOtp(channel: OtpChannel, target: string, code: string, ctx?: { tenantId?: string, ttlMinutes?: number, locale?: string }): Promise<{ ok: boolean }> {
  if (channel === 'email') {
    if (!ctx?.tenantId) { console.error('[otp:email] бракує tenantId для відправки'); return { ok: false } }
    const res = await sendOtpEmail(ctx.tenantId, target, code, ctx.ttlMinutes ?? 5, ctx.locale ?? 'uk')
    if (!res.ok) console.error(`[otp:email] доставка не вдалася (${maskEmail(target)}): ${res.error ?? 'skipped'}`)
    return { ok: res.ok }
  }
  // Заглушка: код в лог. Допустимо только пока SMS_PROVIDER=none (docs/26 §26.6).
  console.log(`[otp:${channel}] ${target} → код ${code}`)
  return { ok: true }
}
