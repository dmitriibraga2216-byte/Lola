import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const N = await import('../../server/services/notifications')
const T = await import('../../server/services/telegram')
const A = await import('../../server/services/notificationActions')
const { withTenant } = await import('../../server/utils/withTenant')

/** docs/23: тихие часы, настройки человека, троттлинг, ретраи, 403 → telegram_blocked, колокольчик, рассылка, эскалация, кнопки бота. */
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
let tenantId: string, adminId: string, lazarevaId: string, posId: string, userId: string
const userIds: string[] = []
const ctx = (actorId = adminId) => ({ tenantId, actorId })
let tgMode: 'ok' | 'blocked' | 'error' = 'ok'
const sentTexts: string[] = []

async function makePerson(name: string, chatId?: number) {
  const phone = `+38095${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, first_name, status, telegram_chat_id) values (${tenantId}, ${phone}, ${name}, ${name.split(' ')[1] ?? name}, 'active', ${chatId ?? null}) returning id`
  userIds.push(u!.id as string)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${lazarevaId}, ${posId}, true)`
  return u!.id as string
}
const enqueue = (uid: string, code: string, payload: Record<string, unknown> = {}, extra: Partial<Parameters<typeof N.enqueueNotification>[1]> = {}) =>
  withTenant(tenantId, adminId, tx => N.enqueueNotification(tx, { tenantId, userId: uid, code, payload, dedupKey: `t:${code}:${uid}:${Date.now()}:${Math.random()}`, ...extra }))
const dueNow = (uid: string) => admin`update notifications set scheduled_for = now() - interval '1 minute' where user_id = ${uid} and status = 'queued'`
const rows = (uid: string) => admin`select code, status, skip_reason, attempt, channel, error from notifications where user_id = ${uid} order by created_at`

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-ntf-${Date.now()}`}, 'barista-ntf') returning id`)[0]!.id as string
  await admin`update locations set manager_id = ${adminId} where id = ${lazarevaId}`
  userId = await makePerson('Сповіщення Тест', 777001)
  process.env.TELEGRAM_BOT_TOKEN = 'test-token'
  T.setTelegramHttp((async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string }
    if (String(url).includes('/sendMessage')) sentTexts.push(body.text ?? '')
    const json = tgMode === 'ok' ? { ok: true } : tgMode === 'blocked' ? { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } : { ok: false, error_code: 500, description: 'Internal' }
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch)
})
afterAll(async () => {
  delete process.env.TELEGRAM_BOT_TOKEN
  T.setTelegramHttp(null)
  if (userIds.length) { await admin`delete from notifications where user_id in ${admin(userIds)}`; await admin`delete from user_notification_prefs where user_id in ${admin(userIds)}`; await admin`delete from users where id in ${admin(userIds)}` }
  await admin`delete from notifications where user_id = ${adminId} and code in ('telegram_blocked_manager','escalation','manual','test_message')`
  await admin`delete from notification_templates where tenant_id = ${tenantId} and code in ('enrollment_due_soon','assignment_created') and locale = 'uk' and channel = 'telegram' and (throttle is not null or escalate_after_hours is not null)`
  await admin`delete from positions where id = ${posId}`
  await admin`update locations set manager_id = null where id = ${lazarevaId}`
  await admin.end()
})

describe('уведомления (docs/23)', () => {
  it('§13.1 тихие часы: событие вне окна переносится на утро с причиной quiet_hours; urgent идёт сразу', async () => {
    const at = N.scheduleWithQuietHours(new Date('2026-09-19T18:30:00Z'), 'Europe/Kyiv') // 21:30 Киев
    expect(at.toISOString()).toBe('2026-09-20T06:00:00.000Z')
    expect(N.scheduleWithQuietHours(new Date('2026-09-19T09:00:00Z'), 'Europe/Kyiv').toISOString()).toBe('2026-09-19T09:00:00.000Z')
    await withTenant(tenantId, adminId, tx => N.enqueueNotification(tx, { tenantId, userId, code: 'assignment_created', payload: { course: 'X' }, dedupKey: `qh:${userId}:${Date.now()}` }))
    const [n] = await admin`select skip_reason, scheduled_for from notifications where user_id = ${userId} order by created_at desc limit 1`
    const kyivHour = Number(new Date().toLocaleString('en-US', { timeZone: 'Europe/Kyiv', hour: 'numeric', hour12: false }))
    if (kyivHour < 9 || kyivHour >= 20) expect(n!.skip_reason).toBe('quiet_hours')
    else expect(n!.skip_reason).toBeNull()
    await admin`delete from notifications where user_id = ${userId}`
  })

  it('§13.2 дедуп: второе событие с тем же ключом не ставится', async () => {
    const key = `dup:${userId}:${Date.now()}`
    expect(await withTenant(tenantId, adminId, tx => N.enqueueNotification(tx, { tenantId, userId, code: 'assignment_created', payload: {}, dedupKey: key }))).toBe(true)
    expect(await withTenant(tenantId, adminId, tx => N.enqueueNotification(tx, { tenantId, userId, code: 'assignment_created', payload: {}, dedupKey: key }))).toBe(false)
    await admin`delete from notifications where user_id = ${userId}`
  })

  it('канал: Telegram → sent с версией шаблона и общими переменными; без чата — in-app (no_channel); настройка человека отключает необязательное', async () => {
    tgMode = 'ok'; sentTexts.length = 0
    await enqueue(userId, 'test_message', {}, { urgent: true })
    await dueNow(userId)
    await N.dispatchNotifications(tenantId, 50)
    expect(sentTexts.at(-1)).toContain('Тест') // {{user.first_name}}
    let r = await rows(userId)
    expect(r[0]).toMatchObject({ status: 'sent', channel: 'telegram' })
    // Без чата — в колокольчик
    const noChat = await makePerson('Без Чату')
    await enqueue(noChat, 'assignment_created', { course: 'Курс' }, { urgent: true })
    await dueNow(noChat)
    await N.dispatchNotifications(tenantId, 50)
    expect((await rows(noChat))[0]).toMatchObject({ status: 'skipped', skip_reason: 'no_channel' })
    const box = await N.inbox({ tenantId, actorId: noChat })
    expect(box.unread).toBe(1)
    expect(box.items[0]!.text).toContain('Курс')
    expect(await N.markRead({ tenantId, actorId: noChat })).toBe(1)
    expect((await N.inbox({ tenantId, actorId: noChat })).unread).toBe(0)
    // Настройки: необязательный код можно выключить, обязательный — нет
    expect(await N.setPref({ tenantId, actorId: userId }, { code: 'news_published', enabled: false })).toEqual({ ok: true })
    expect(await N.setPref({ tenantId, actorId: userId }, { code: 'enrollment_due_today', enabled: false })).toMatchObject({ ok: false, code: 'mandatory' })
    await enqueue(userId, 'news_published', { title: 'N' }, { urgent: true })
    await dueNow(userId)
    await N.dispatchNotifications(tenantId, 50)
    r = await rows(userId)
    expect(r.at(-1)).toMatchObject({ code: 'news_published', status: 'skipped', skip_reason: 'unsubscribed' })
    await admin`delete from notifications where user_id in (${userId}, ${noChat})`
  })

  it('§6.4 троттлинг: max_per_day по коду и общий лимит 10 в сутки; дедлайны обходят лимит', async () => {
    tgMode = 'ok'
    const u = await makePerson('Ліміт Тест', 777002)
    await admin`insert into notification_templates (tenant_id, code, channel, locale, body, throttle) values (${tenantId}, 'assignment_created', 'telegram', 'uk', 'Курс {{course}}', '{"maxPerDay": 1}')`
    for (let i = 0; i < 2; i++) await enqueue(u, 'assignment_created', { course: `C${i}` }, { urgent: true })
    await dueNow(u)
    await N.dispatchNotifications(tenantId, 50)
    let r = await rows(u)
    expect(r.filter(x => x.status === 'sent').length).toBe(1)
    expect(r.filter(x => x.skip_reason === 'throttled').length).toBe(1)
    await admin`delete from notification_templates where tenant_id = ${tenantId} and code = 'assignment_created' and channel = 'telegram' and locale = 'uk'`
    // Общий лимит: 10 отправлено сегодня → 11-е необязательное throttled, дедлайн проходит
    await admin`delete from notifications where user_id = ${u}`
    for (let i = 0; i < 10; i++) await admin`insert into notifications (tenant_id, user_id, code, channel, payload, status, sent_at, dedup_key) values (${tenantId}, ${u}, 'news_published', 'telegram', '{}', 'sent', now(), ${`sent${i}:${u}`})`
    await enqueue(u, 'news_published', { title: 'Ще' })
    await enqueue(u, 'enrollment_due_today', { course: 'Дедлайн' })
    await dueNow(u)
    await N.dispatchNotifications(tenantId, 50)
    r = await rows(u)
    expect(r.find(x => x.code === 'news_published' && x.status === 'skipped')?.skip_reason).toBe('throttled')
    expect(r.find(x => x.code === 'enrollment_due_today')?.status).toBe('sent')
  })

  it('§6.5 ретраи с экспонентой: 5xx → снова в очередь, attempt растёт; 403 → telegram_blocked, руководителю уведомление', async () => {
    tgMode = 'error'
    const u = await makePerson('Ретрай Тест', 777003)
    await enqueue(u, 'assignment_created', { course: 'R' }, { urgent: true })
    await dueNow(u)
    await N.dispatchNotifications(tenantId, 50)
    let [r] = await rows(u)
    expect(r).toMatchObject({ status: 'queued', attempt: 1 })
    const [sched] = await admin`select scheduled_for > now() + interval '4 minutes' as later from notifications where user_id = ${u}`
    expect(sched!.later).toBe(true)
    // Блокировка бота
    tgMode = 'blocked'
    await dueNow(u)
    await N.dispatchNotifications(tenantId, 50)
    ;[r] = await rows(u)
    expect(r!.status).toBe('skipped')
    const [usr] = await admin`select telegram_blocked from users where id = ${u}`
    expect(usr!.telegram_blocked).toBe(true)
    const [mgr] = await admin`select count(*)::int as c from notifications where user_id = ${adminId} and code = 'telegram_blocked_manager'`
    expect(mgr!.c).toBeGreaterThanOrEqual(1)
    expect((await N.notificationsReport(ctx())).blocked.some(b => b.id === u)).toBe(true)
    tgMode = 'ok'
  })

  it('§13.6 ручная рассылка: попадает в журнал как manual с автором; повторная отправка', async () => {
    const u = await makePerson('Розсилка Тест', 777004)
    const r = await N.broadcast(ctx(), { audience: { rules: [{ type: 'user', ids: [u] }], match: 'any' }, text: 'Завтра інвентаризація о 8:00' })
    expect(r).toEqual({ recipients: 1, queued: 1 })
    const [n] = await admin`select id, code, payload from notifications where user_id = ${u}`
    expect(n).toMatchObject({ code: 'manual' })
    expect((n!.payload as { author: string }).author).toBe('Адмін Каппі')
    await admin`update notifications set status = 'failed' where id = ${n!.id}`
    expect(await N.resend(ctx(), n!.id as string)).toBe(true)
    const [again] = await admin`select status, attempt from notifications where id = ${n!.id}`
    expect(again).toMatchObject({ status: 'queued', attempt: 0 })
  })

  it('§6.6 эскалация: без реакции через N часов — руководителю; §7 кнопки: отложить дважды, третий раз — отказ; «не нагадувати» только необязательное', async () => {
    const u = await makePerson('Ескалація Тест', 777005)
    await admin`insert into notification_templates (tenant_id, code, channel, locale, body, escalate_after_hours) values (${tenantId}, 'enrollment_due_soon', 'telegram', 'uk', 'Скоро {{course}}', 1)`
    await admin`update notification_templates set is_mandatory = true where tenant_id = ${tenantId} and code = 'enrollment_due_soon' and channel = 'telegram'`
    await admin`insert into notifications (tenant_id, user_id, code, channel, payload, status, sent_at, rendered_text, dedup_key) values (${tenantId}, ${u}, 'enrollment_due_soon', 'telegram', '{"course":"К"}', 'sent', now() - interval '2 hours', 'Скоро К', ${`esc:${u}`})`
    expect(await N.escalationScan(tenantId)).toBe(1)
    expect(await N.escalationScan(tenantId)).toBe(0)
    const [e] = await admin`select count(*)::int as c from notifications where user_id = ${adminId} and code = 'escalation'`
    expect(e!.c).toBeGreaterThanOrEqual(1)
    const [n] = await admin`select id from notifications where user_id = ${u} and code = 'enrollment_due_soon'`
    // Реакция снимает эскалацию в отчёте
    await N.markReacted(tenantId, n!.id as string)
    const [rx] = await admin`select reacted_at from notifications where id = ${n!.id}`
    expect(rx!.reacted_at).not.toBeNull()
    // Кнопки бота
    expect(await A.snooze(tenantId, u, n!.id as string)).toBe('ok')
    const [s1] = await admin`select id from notifications where user_id = ${u} and payload->>'snoozed' = '1'`
    expect(await A.snooze(tenantId, u, s1!.id as string)).toBe('ok')
    const [s2] = await admin`select id from notifications where user_id = ${u} and payload->>'snoozed' = '2'`
    expect(await A.snooze(tenantId, u, s2!.id as string)).toBe('limit')
    expect(await A.mute(tenantId, u, n!.id as string)).toBe('mandatory')
    await admin`insert into notifications (tenant_id, user_id, code, channel, payload, status, dedup_key) values (${tenantId}, ${u}, 'news_published', 'telegram', '{}', 'sent', ${`mute:${u}`})`
    const [m] = await admin`select id from notifications where user_id = ${u} and code = 'news_published'`
    expect(await A.mute(tenantId, u, m!.id as string)).toBe('ok')
    expect((await N.listPrefs({ tenantId, actorId: u })).find(p => p.code === 'news_published')?.enabled).toBe(false)
  })
})

/**
 * Голодание очереди эскалаций (docs/23 §6.6, PR-30). Адресат известен только после
 * `resolveManager()`, поэтому отбор берёт и тех, у кого руководителя нет. Раньше такие строки
 * пропускались без отметки: выбирались снова каждый проход, и при двух сотнях таких строк окно
 * `ESCALATION_BATCH` навсегда занимали они — до человека с руководителем очередь не доходила.
 * Теперь каждая выбранная строка закрывается (`escalated_at`, «некому» — без `escalated_to_id`),
 * и окно сдвигается от старых отправок к новым.
 */
describe('эскалация: строки без руководителя не занимают окно навсегда', () => {
  it('больше ESCALATION_BATCH строк без руководителя и одна с руководителем — эскалация за два прохода', async () => {
    const BACKLOG = N.ESCALATION_BATCH + 50
    await admin`
      insert into notification_templates (tenant_id, code, channel, locale, body, escalate_after_hours)
      values (${tenantId}, 'enrollment_due_soon', 'telegram', 'uk', 'Скоро {{course}}', 1)
      on conflict (tenant_id, code, channel, locale) do update set escalate_after_hours = 1`
    // Без размещения: ни точки, ни роли в области, ни дерева — руководителя нет ни по одному шагу.
    const phone = `+38095${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
    const [lonerRow] = await admin`insert into users (tenant_id, phone, full_name, first_name, status) values (${tenantId}, ${phone}, 'Без Керівника', 'Керівника', 'active') returning id`
    const loner = lonerRow!.id as string
    userIds.push(loner)
    // Хвост старше — худший случай для разбора «от старых к новым»: человек с руководителем стоит
    // в очереди последним.
    await admin`
      insert into notifications (tenant_id, user_id, code, channel, payload, status, sent_at, rendered_text, dedup_key)
      select ${tenantId}, ${loner}, 'enrollment_due_soon', 'telegram', '{}'::jsonb, 'sent',
             now() - interval '3 hours' - make_interval(secs => g), 'Скоро К', 'starve:' || ${loner}::text || ':' || g
      from generate_series(1, ${BACKLOG}::int) g`
    const managed = await makePerson('Має Керівника')
    const [target] = await admin`
      insert into notifications (tenant_id, user_id, code, channel, payload, status, sent_at, rendered_text, dedup_key)
      values (${tenantId}, ${managed}, 'enrollment_due_soon', 'telegram', '{}', 'sent', now() - interval '2 hours', 'Скоро К', ${`starve:${managed}`})
      returning id`
    const lonerState = async () => (await admin`
      select count(*) filter (where escalated_at is not null)::int as closed,
             count(*) filter (where escalated_to_id is not null)::int as addressed
      from notifications where user_id = ${loner}`)[0]!
    const targetState = async () => (await admin`select escalated_at, escalated_to_id from notifications where id = ${target!.id}`)[0]!

    // Проход 1: окно целиком — строки без руководителя, и все они закрыты как «некому».
    await N.escalationScan(tenantId)
    expect(await lonerState(), 'окно не закрылось — следующий проход выберет те же строки').toEqual({ closed: N.ESCALATION_BATCH, addressed: 0 })
    expect((await targetState()).escalated_at).toBeNull()

    // Проход 2: остаток хвоста и человек с руководителем — эскалация дошла.
    await N.escalationScan(tenantId)
    expect(await lonerState()).toEqual({ closed: BACKLOG, addressed: 0 })
    const t = await targetState()
    expect(t.escalated_at, 'до человека с руководителем очередь так и не дошла').not.toBeNull()
    expect(t.escalated_to_id).toBe(adminId)
    const [esc] = await admin`select user_id from notifications where tenant_id = ${tenantId} and dedup_key = ${`esc:${target!.id}`}`
    expect(esc!.user_id).toBe(adminId)

    // Проход 3: разбирать больше нечего — закрытые строки не возвращаются.
    expect(await N.escalationScan(tenantId)).toBe(0)
    expect(await lonerState()).toEqual({ closed: BACKLOG, addressed: 0 })
  })
})
