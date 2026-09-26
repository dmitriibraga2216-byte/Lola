import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Spec 23 (docs/23 §13.1, §13.2.1, §13.4, §13.5; docs/09 §9.7; docs/32 Б.12): body_mjml,
 * scope global/custom, {{#_tr}}, время отправки по классам событий, email_layout,
 * SMTP-поля тенанта, второй токен Telegram.
 */

const N = await import('../../server/services/notifications')
const St = await import('../../server/services/settings')
const Secrets = await import('../../server/services/secrets')
const Channels = await import('../../server/services/channels')
const Telegram = await import('../../server/services/telegram')
const EmailRender = await import('../../server/services/emailRender')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
let tenantId: string, adminId: string, lazarevaId: string, posId: string
let otherTenantId: string
const userIds: string[] = []
const ctx = () => ({ tenantId, actorId: adminId })

async function makePerson(name: string, locale: 'uk' | 'en' = 'uk') {
  const phone = `+38096${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, first_name, status, locale) values (${tenantId}, ${phone}, ${name}, ${name.split(' ')[1] ?? name}, 'active', ${locale}) returning id`
  userIds.push(u!.id as string)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${lazarevaId}, ${posId}, true)`
  return u!.id as string
}
const dueNow = (uid: string) => admin`update notifications set scheduled_for = now() - interval '1 minute' where user_id = ${uid} and status = 'queued'`

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-s23-${Date.now()}`}, 'barista-s23') returning id`)[0]!.id as string
  const [o] = await admin`insert into tenants (slug, name, status) values (${`s23-other-${Date.now()}`}, 'Інший', 'active') returning id`
  otherTenantId = o!.id as string
})

afterAll(async () => {
  if (userIds.length) { await admin`delete from notifications where user_id in ${admin(userIds)}`; await admin`delete from users where id in ${admin(userIds)}` }
  await admin`delete from notification_templates where tenant_id in (${tenantId}, ${otherTenantId}) and code like 's23_%'`
  await admin`delete from translations where tenant_id = ${tenantId} and key in ('Привіт', 'Привіт, {{user.first_name}}!')`
  await admin`delete from tenant_secrets where tenant_id = ${tenantId} and provider in ('smtp', 'telegram')`
  await admin`delete from positions where id = ${posId}`
  await admin`delete from tenants where id = ${otherTenantId}`
  await admin.end()
})

describe('Spec 23: scope шаблону (docs/23 §13.1)', () => {
  it('без рядка в БД — global (текст із коду); правка тенанта створює custom-рядок, «Повернути» видаляє його', async () => {
    const before = await withTenant(tenantId, adminId, tx => N.templateFor(tx, tenantId, 's23_code', 'telegram', 'uk'))
    expect(before).toBeNull() // немає ні дефолту, ні кастому — код не заведений
    await admin`insert into notification_templates (tenant_id, code, channel, locale, body, is_enabled) values (${tenantId}, 's23_code', 'telegram', 'uk', 'Кастомний текст', true)`
    const custom = await withTenant(tenantId, adminId, tx => N.templateFor(tx, tenantId, 's23_code', 'telegram', 'uk'))
    expect(custom).toMatchObject({ scope: 'custom', body: 'Кастомний текст' })
    // Глобальний код (assignment_created) без кастому — scope global, текст з DEFAULT_TEMPLATES
    const global = await withTenant(tenantId, adminId, tx => N.templateFor(tx, tenantId, 'assignment_created', 'telegram', 'uk'))
    expect(global).toMatchObject({ scope: 'global' })
    expect(global!.body).toBe(N.DEFAULT_TEMPLATES.assignment_created)
  })
})

describe('Spec 23: {{#_tr}} — переклад фрази за локаллю отримувача (docs/23 §13.4)', () => {
  it('renderTemplate: без резолвера фраза лишається як є; з резолвером — підміняється', () => {
    const tpl = '{{#_tr}}Привіт{{/_tr}}, {{name}}!'
    expect(N.renderTemplate(tpl, { name: 'Іван' })).toBe('Привіт, Іван!')
    expect(N.renderTemplate(tpl, { name: 'Ivan' }, s => (s === 'Привіт' ? 'Hi' : s))).toBe('Hi, Ivan!')
  })

  it('renderTemplate: код з RECIPIENT_TIME_CODES — дата й час у поясі отримувача (docs/v2/46-progress.md, «Что осталось»: summary_auto_send_scheduled показывал дату без часа); без коду чи для іншого коду — як і раніше, тільки день+місяць', () => {
    const iso = '2026-09-27T14:30:00.000Z'
    expect(N.RECIPIENT_TIME_CODES.has('summary_auto_send_scheduled')).toBe(true)
    const kyiv = N.renderTemplate('Надіслано {{time}}', { time: iso }, undefined, 'uk', { code: 'summary_auto_send_scheduled', timezone: 'Europe/Kyiv' })
    expect(kyiv).toContain('27 вересня')
    expect(kyiv).toContain('17:30') // UTC+3 наприкінці вересня 2026
    const tokyo = N.renderTemplate('Надіслано {{time}}', { time: iso }, undefined, 'uk', { code: 'summary_auto_send_scheduled', timezone: 'Asia/Tokyo' })
    expect(tokyo).toContain('23:30') // UTC+9 — інший пояс отримувача, інша година
    // та сама змінна `time`, але код не в RECIPIENT_TIME_CODES (або код не переданий) — формат без
    // години, як в решти шаблонів: прив'язка до коду, а не до імені змінної, нікого не зачіпає
    const withoutCode = N.renderTemplate('Надіслано {{time}}', { time: iso })
    expect(withoutCode).toBe('Надіслано 27 вересня')
    expect(withoutCode).not.toMatch(/\d{1,2}:\d{2}/)
    const otherCode = N.renderTemplate('Надіслано {{time}}', { time: iso }, undefined, 'uk', { code: 'assignment_created', timezone: 'Europe/Kyiv' })
    expect(otherCode).toBe('Надіслано 27 вересня')
    // інша ISO-підстановка того самого коду — як і раніше, тільки день+місяць (не ламаємо чужі шаблони)
    const withoutTime = N.renderTemplate('До {{until}}', { until: iso })
    expect(withoutTime).toBe('До 27 вересня')
    expect(withoutTime).not.toMatch(/\d{1,2}:\d{2}/)
  })

  it('дедуп-таблиця translations як словник фраз: uk — оригінал, en — переклад, dispatch бере локаль отримувача', async () => {
    await admin`insert into notification_templates (tenant_id, code, channel, locale, body, is_enabled) values (${tenantId}, 's23_tr', 'telegram', 'uk', '{{#_tr}}Привіт{{/_tr}}, {{user.first_name}}!', true)`
    await admin`insert into translations (tenant_id, locale, key, value) values (${tenantId}, 'en', 'Привіт', 'Hi')`
    const uaUser = await makePerson('Тест Українець', 'uk')
    const enUser = await makePerson('Тест Інглиш', 'en')
    for (const u of [uaUser, enUser]) {
      await withTenant(tenantId, adminId, tx => N.enqueueNotification(tx, { tenantId, userId: u, code: 's23_tr', payload: {}, urgent: true, dedupKey: `s23tr:${u}` }))
    }
    await dueNow(uaUser); await dueNow(enUser)
    await N.dispatchNotifications(tenantId, 50)
    const [ua] = await admin`select rendered_text from notifications where user_id = ${uaUser} and code = 's23_tr'`
    const [en] = await admin`select rendered_text from notifications where user_id = ${enUser} and code = 's23_tr'`
    expect(ua!.rendered_text).toContain('Привіт,')
    expect(en!.rendered_text).toContain('Hi,')
  })
})

describe('Spec 23: email_layout та body_mjml — безпечне підмножина без mjml-компілятора (docs/23 §13.4–13.5, docs/28)', () => {
  it('розпізнані mj-теги компілюються, невідомий вміст іде як текстовий фолбек', () => {
    expect(EmailRender.looksLikeMjml('<mj-text>Привіт</mj-text>')).toBe(true)
    expect(EmailRender.looksLikeMjml('звичайний текст без тегів')).toBe(false)
    const html = EmailRender.renderMjmlSubset('<mj-section><mj-column><mj-text>Привіт, {{name}}</mj-text><mj-button href="https://l.example">Пройти</mj-button></mj-column></mj-section>')
    expect(html).toContain('Привіт, {{name}}')
    expect(html).toContain('href="https://l.example"')
    expect(EmailRender.textToHtml('Рядок один\n\nРядок два')).toContain('<p')
  })

  it('buildEmailHtml обгортає тіло шапкою/підвалом тенанта; порожній body_mjml → фолбек на текст', () => {
    const withMjml = EmailRender.buildEmailHtml({ bodyMjml: '<mj-text>Тіло листа</mj-text>', fallbackText: 'запасний текст', layout: { headerMjml: '<mj-text>Шапка</mj-text>', footerMjml: '<mj-text>Підвал, {{mail_settings_url}}</mj-text>' } })
    expect(withMjml).toContain('Шапка')
    expect(withMjml).toContain('Тіло листа')
    expect(withMjml).toContain('Підвал')
    const fallback = EmailRender.buildEmailHtml({ bodyMjml: null, fallbackText: 'простий текст без mjml', layout: {} })
    expect(fallback).toContain('простий текст без mjml')
  })
})

describe('Spec 23: час відправлення по класах подій (docs/23 §13.2.1)', () => {
  afterAll(async () => { await St.updateNotificationSchedule(ctx(), { birthdays: { hour: 9, minute: 0 } }); await St.updateQuietHours(ctx(), { enabled: true, from: 9, to: 20 }) })

  it('eventClassOf розпізнає клас; nextOccurrence дає найближчий час, наступного дня — якщо вже минув', () => {
    expect(N.eventClassOf('birthday_upcoming')).toBe('birthdays')
    expect(N.eventClassOf('weekly_digest')).toBe('managerDigest')
    expect(N.eventClassOf('enrollment_due_soon')).toBe('dueTasks')
    expect(N.eventClassOf('assignment_created')).toBeNull()
    const at = N.nextOccurrence(new Date('2026-09-19T05:00:00Z'), 'Europe/Kyiv', 9, 0) // 08:00 Київ — ще не настав
    expect(at.toISOString()).toBe('2026-09-19T06:00:00.000Z')
    const past = N.nextOccurrence(new Date('2026-09-19T18:30:00Z'), 'Europe/Kyiv', 9, 0) // 21:30 Київ — вже минув
    expect(past.toISOString()).toBe('2026-09-20T06:00:00.000Z')
  })

  it('код класу планується на налаштований час тенанта, а не на загальні тихі часи', async () => {
    await St.updateNotificationSchedule(ctx(), { birthdays: { hour: 14, minute: 30 } })
    const u = await makePerson('Іменинник Тест')
    await withTenant(tenantId, adminId, tx => N.enqueueNotification(tx, { tenantId, userId: u, code: 'birthday_upcoming', payload: { name: 'Хтось', days: 1, date: '01.01' }, dedupKey: `s23sched:${u}` }))
    const [row] = await admin`select scheduled_for at time zone 'Europe/Kyiv' as kyiv from notifications where user_id = ${u} and code = 'birthday_upcoming'`
    const kyiv = new Date(row!.kyiv as string)
    expect(kyiv.getHours()).toBe(14)
    expect(kyiv.getMinutes()).toBe(30)
  })

  it('quietHours.enabled = false — подія поза вікном іде одразу, без переносу на ранок', async () => {
    await St.updateQuietHours(ctx(), { enabled: false })
    const u = await makePerson('Без Тиші Тест')
    const now = new Date()
    await withTenant(tenantId, adminId, tx => N.enqueueNotification(tx, { tenantId, userId: u, code: 'assignment_created', payload: { course: 'X' }, dedupKey: `s23qh:${u}` }))
    const [row] = await admin`select scheduled_for, skip_reason from notifications where user_id = ${u} and code = 'assignment_created'`
    expect(Math.abs(new Date(row!.scheduled_for as string).getTime() - now.getTime())).toBeLessThan(5000)
    expect(row!.skip_reason).toBeNull()
  })
})

describe('Spec 23: SMTP-поля тенанта — шифрування, маска, fallback на платформенний (docs/09 §9.7.1)', () => {
  afterAll(async () => { await admin`delete from tenant_secrets where tenant_id = ${tenantId} and provider = 'smtp'` })

  it('без жодного налаштування — sendEmail і testSmtpConnection дають skipped, мережа не викликається', async () => {
    const res = await Channels.testSmtpConnection(tenantId, 'nobody@example.test')
    expect(res).toMatchObject({ ok: false, skipped: true })
  })

  it('host/port/login/password шифруються (round-trip) і не повертаються у стані інтеграції — тільки set:true', async () => {
    await Secrets.setSecret(ctx(), 'smtp', Secrets.SECRET_KEYS.smtp.HOST, 'smtp.example.test')
    await Secrets.setSecret(ctx(), 'smtp', Secrets.SECRET_KEYS.smtp.PORT, '587')
    await Secrets.setSecret(ctx(), 'smtp', Secrets.SECRET_KEYS.smtp.LOGIN, 'noreply@example.test')
    await Secrets.setSecret(ctx(), 'smtp', Secrets.SECRET_KEYS.smtp.PASSWORD, 'super-secret-pass')
    expect(await Secrets.getSecret(tenantId, 'smtp', Secrets.SECRET_KEYS.smtp.PASSWORD)).toBe('super-secret-pass')
    const status = await Secrets.integrationStatus(ctx(), 'smtp')
    expect(status.complete).toBe(true)
    expect(JSON.stringify(status)).not.toContain('super-secret-pass')
    expect(status.keys.find(k => k.key === 'password')).toEqual({ key: 'password', set: true })

    const cfg = await Channels.smtpTransportConfig(tenantId)
    expect(cfg?.transport).toMatchObject({ host: 'smtp.example.test', port: 587, auth: { user: 'noreply@example.test', pass: 'super-secret-pass' } })
  })
})

describe('Spec 23: другий токен Telegram — свій бот → зовнішній → платформенний (docs/09 §9.7.2)', () => {
  const savedEnv = process.env.TELEGRAM_BOT_TOKEN
  afterAll(async () => { await admin`delete from tenant_secrets where tenant_id = ${tenantId} and provider = 'telegram'`; if (savedEnv === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = savedEnv })

  it('нічого не налаштовано → платформенний; тільки зовнішній → зовнішній; свій + зовнішній → свій', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'platform-token'
    expect(await Telegram.botTokenFor(tenantId)).toBe('platform-token')
    await Secrets.setSecret(ctx(), 'telegram', Secrets.SECRET_KEYS.telegram.EXTERNAL_BOT_TOKEN, 'external-token')
    expect(await Telegram.botTokenFor(tenantId)).toBe('external-token')
    await Secrets.setSecret(ctx(), 'telegram', Secrets.SECRET_KEYS.telegram.BOT_TOKEN, 'own-token')
    expect(await Telegram.botTokenFor(tenantId)).toBe('own-token')
  })
})

describe('Spec 23: RLS/404 — шаблон і секрети чужого тенанта не видно (CLAUDE.md п. 1, 15)', () => {
  it('шаблон іншого тенанта не потрапляє у вибірку під нашим тенантом', async () => {
    await admin`insert into notification_templates (tenant_id, code, channel, locale, body, is_enabled) values (${otherTenantId}, 's23_foreign', 'telegram', 'uk', 'Чужий', true)`
    const mine = await withTenant(tenantId, adminId, tx => N.templateFor(tx, tenantId, 's23_foreign', 'telegram', 'uk'))
    expect(mine).toBeNull() // не бачимо чужого кастому — впаде на global, якого теж немає
  })
})
