import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * PR `spec-integrations` (docs/09 §9.7, докс/33 D-050, docs/23 §13.1):
 * — расширенные поля SMTP тенанта доходят до `sendEmail` (queue delay, размер вкладення, SSL,
 *   режим відлагодження) и «Ігнорувати помилки TLS» доступний лише оператору платформи;
 * — дефолтний стан тумблерів Email/Telegram для глобального шаблону (`DEFAULT_TEMPLATE_CHANNELS`)
 *   і те, що вимкнений кастомним оверрайдом канал не отримує повідомлення (docs/23 §13.1).
 */

const Secrets = await import('../../server/services/secrets')
const Channels = await import('../../server/services/channels')
const Platform = await import('../../server/services/platform')
const PlatformTenants = await import('../../server/services/platformTenants')
const N = await import('../../server/services/notifications')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const MAILPIT = 'http://localhost:8025'

let tenantId: string, adminId: string, lazarevaId: string, posId: string
const userIds: string[] = []
const ctx = () => ({ tenantId, actorId: adminId })

async function makePerson(name: string, chatId?: number) {
  const phone = `+38094${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, first_name, status, telegram_chat_id) values (${tenantId}, ${phone}, ${name}, ${name.split(' ')[1] ?? name}, 'active', ${chatId ?? null}) returning id`
  userIds.push(u!.id as string)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${lazarevaId}, ${posId}, true)`
  return u!.id as string
}
const dueNow = (uid: string) => admin`update notifications set scheduled_for = now() - interval '1 minute' where user_id = ${uid} and status = 'queued'`

async function messagesTo(address: string): Promise<{ ID: string }[]> {
  const res = await fetch(`${MAILPIT}/api/v1/messages?limit=50`)
  const body = await res.json() as { messages: { ID: string, To: { Address: string }[] }[] }
  return body.messages.filter(m => m.To.some(t => t.Address === address))
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-si-${Date.now()}`}, 'barista-si') returning id`)[0]!.id as string
  process.env.PLATFORM_ADMIN_EMAIL = 'ops-si-test@lola.local'
  process.env.PLATFORM_ADMIN_PASSWORD = 'test-password-123'
  await Platform.ensureFirstAdmin()
})

afterAll(async () => {
  if (userIds.length) { await admin`delete from notifications where user_id in ${admin(userIds)}`; await admin`delete from users where id in ${admin(userIds)}` }
  await admin`delete from notification_templates where tenant_id = ${tenantId} and code like 'si_%'`
  await admin`delete from tenant_secrets where tenant_id = ${tenantId} and provider = 'smtp'`
  await admin`delete from platform_audit where subject_tenant_id = ${tenantId} and action = 'tenant.smtp_ignore_tls_errors'`
  await admin`delete from platform_admins where email = 'ops-si-test@lola.local'`
  await admin`delete from positions where id = ${posId}`
  await admin.end()
})

describe('SECRET_KEYS: розширені поля SMTP (докс/33 D-050, docs/09 §9.7.1)', () => {
  const resetSmtp = () => admin`delete from tenant_secrets where tenant_id = ${tenantId} and provider = 'smtp'`
  afterAll(resetSmtp)

  it('«Ігнорувати помилки TLS» — платформенний ключ: тенант його не бачить у стані інтеграції', async () => {
    await resetSmtp()
    expect(Secrets.PLATFORM_ONLY_KEYS.smtp).toContain(Secrets.SECRET_KEYS.smtp.IGNORE_TLS_ERRORS)
    await Secrets.setSecret(ctx(), 'smtp', Secrets.SECRET_KEYS.smtp.HOST, 'localhost')
    const status = await Secrets.integrationStatus(ctx(), 'smtp')
    expect(status.keys.some(k => k.key === 'ignore_tls_errors')).toBe(false)
  })

  it('SSL/режим відлагодження/черга/вкладення шифруються, маскуються і доходять до транспорту nodemailer', async () => {
    await resetSmtp()
    await Secrets.setSecret(ctx(), 'smtp', Secrets.SECRET_KEYS.smtp.HOST, 'localhost')
    await Secrets.setSecret(ctx(), 'smtp', Secrets.SECRET_KEYS.smtp.PORT, '1025')
    await Secrets.setSecret(ctx(), 'smtp', Secrets.SECRET_KEYS.smtp.SSL, 'true')
    await Secrets.setSecret(ctx(), 'smtp', Secrets.SECRET_KEYS.smtp.DEBUG_MODE, 'true')
    await Secrets.setSecret(ctx(), 'smtp', Secrets.SECRET_KEYS.smtp.QUEUE_DELAY_MS, '120')
    await Secrets.setSecret(ctx(), 'smtp', Secrets.SECRET_KEYS.smtp.MAX_ATTACHMENT_MB, '5')
    const status = await Secrets.integrationStatus(ctx(), 'smtp')
    expect(JSON.stringify(status)).not.toContain('120') // значення секретів нікуди не потрапляють — лише set:true
    expect(status.keys.find(k => k.key === 'ssl')).toEqual({ key: 'ssl', set: true })

    const cfg = await Channels.smtpTransportConfig(tenantId)
    expect(cfg).toMatchObject({ queueDelayMs: 120, maxAttachmentMb: 5 })
    expect(cfg!.transport).toMatchObject({ secure: true, logger: true, debug: true })
  })

  it('«Ігнорувати помилки TLS» вмикає лише оператор платформи; читання — звичайне, tls.rejectUnauthorized:false', async () => {
    await resetSmtp()
    await Secrets.setSecret(ctx(), 'smtp', Secrets.SECRET_KEYS.smtp.HOST, 'localhost')
    const login = await Platform.platformLogin('ops-si-test@lola.local', 'test-password-123')
    const actor = (await Platform.validatePlatformSession(login!.token))!
    expect(await PlatformTenants.getSmtpIgnoreTlsErrors(tenantId)).toBe(false)
    await PlatformTenants.setSmtpIgnoreTlsErrors(tenantId, true, actor)
    expect(await PlatformTenants.getSmtpIgnoreTlsErrors(tenantId)).toBe(true)
    const cfg = await Channels.smtpTransportConfig(tenantId)
    expect(cfg!.transport).toMatchObject({ secure: false, tls: { rejectUnauthorized: false } })
    const [row] = await admin`select action, subject_tenant_id, after from platform_audit where subject_tenant_id = ${tenantId} and action = 'tenant.smtp_ignore_tls_errors' order by created_at desc limit 1`
    expect(row).toMatchObject({ action: 'tenant.smtp_ignore_tls_errors' })
    expect((row!.after as { ignoreTlsErrors: boolean }).ignoreTlsErrors).toBe(true)
  })

  it('«Максимальний розмір вкладення» — відсічка до спроби зʼєднання', async () => {
    await resetSmtp()
    await Secrets.setSecret(ctx(), 'smtp', Secrets.SECRET_KEYS.smtp.HOST, 'localhost')
    await Secrets.setSecret(ctx(), 'smtp', Secrets.SECRET_KEYS.smtp.PORT, '1025')
    await Secrets.setSecret(ctx(), 'smtp', Secrets.SECRET_KEYS.smtp.MAX_ATTACHMENT_MB, '1')
    const big = await Channels.sendEmail(tenantId, 'nobody@example.test', 'x', 'x', undefined, 2 * 1024 * 1024)
    expect(big).toMatchObject({ ok: false, skipped: true })
    const ok = await Channels.sendEmail(tenantId, `si-attach-${Date.now()}@example.test`, 'x', 'x', undefined, 512 * 1024)
    expect(ok.ok).toBe(true)
  })

  it('«Час затримки повідомлення в черзі» реально затримує відправку (докс/09 §9.7.1)', async () => {
    await resetSmtp()
    await Secrets.setSecret(ctx(), 'smtp', Secrets.SECRET_KEYS.smtp.HOST, 'localhost')
    await Secrets.setSecret(ctx(), 'smtp', Secrets.SECRET_KEYS.smtp.PORT, '1025')
    await Secrets.setSecret(ctx(), 'smtp', Secrets.SECRET_KEYS.smtp.QUEUE_DELAY_MS, '150')
    const addr = `si-delay-${Date.now()}@example.test`
    const at = Date.now()
    const res = await Channels.sendEmail(tenantId, addr, 'Lola — затримка', 'перевірка черги')
    expect(res.ok).toBe(true)
    expect(Date.now() - at).toBeGreaterThanOrEqual(140)
    expect((await messagesTo(addr)).length).toBeGreaterThan(0)
  })
})

describe('Канали шаблонів сповіщень (docs/23 §13.1)', () => {
  it('DEFAULT_TEMPLATE_CHANNELS: керівникам/дайджестам/вивантаженням і системним викликам — email за замовчуванням; іншим — ні', () => {
    expect(N.DEFAULT_TEMPLATE_CHANNELS.security_alert).toMatchObject({ telegram: true, email: true, inapp: true })
    expect(N.DEFAULT_TEMPLATE_CHANNELS.enrollment_overdue_manager?.email).toBe(true)
    expect(N.DEFAULT_TEMPLATE_CHANNELS.weekly_digest?.email).toBe(true) // клас managerDigest
    expect(N.DEFAULT_TEMPLATE_CHANNELS.otp_code?.email).toBe(true) // системний виклик, не шаблонна політика
    expect(N.DEFAULT_TEMPLATE_CHANNELS.manual?.email).toBe(true) // ручна розсилка — канал обирає автор
    expect(N.DEFAULT_TEMPLATE_CHANNELS.assignment_created?.email).toBe(false)
    expect(N.DEFAULT_TEMPLATE_CHANNELS.assignment_created).toMatchObject({ telegram: true, inapp: true })
  })

  it('канал вимкнено кастомним оверрайдом → сповіщення цим каналом не йде (skip_reason template_disabled)', async () => {
    const u = await makePerson('Канал Вимкнено Тест', 888001)
    await admin`insert into notification_templates (tenant_id, code, channel, locale, body, is_enabled) values (${tenantId}, 'si_off', 'telegram', 'uk', 'Текст {{x}}', false)`
    await withTenant(tenantId, adminId, tx => N.enqueueNotification(tx, { tenantId, userId: u, code: 'si_off', payload: { x: '1' }, urgent: true, dedupKey: `si_off:${u}` }))
    await dueNow(u)
    await N.dispatchNotifications(tenantId, 50)
    const [row] = await admin`select status, skip_reason from notifications where user_id = ${u} and code = 'si_off'`
    expect(row).toMatchObject({ status: 'skipped', skip_reason: 'template_disabled' })
  })

  it('канал знову увімкнено кастомним оверрайдом → сповіщення доставляється', async () => {
    const u = await makePerson('Канал Увімкнено Тест', 888002)
    await admin`insert into notification_templates (tenant_id, code, channel, locale, body, is_enabled) values (${tenantId}, 'si_on', 'telegram', 'uk', 'Текст {{x}}', true)`
    await withTenant(tenantId, adminId, tx => N.enqueueNotification(tx, { tenantId, userId: u, code: 'si_on', payload: { x: '1' }, urgent: true, dedupKey: `si_on:${u}` }))
    await dueNow(u)
    await N.dispatchNotifications(tenantId, 50)
    const [row] = await admin`select status from notifications where user_id = ${u} and code = 'si_on'`
    expect(row).toMatchObject({ status: 'sent' })
  })
})
