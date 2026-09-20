import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Spec 21 (docs/21 §14.5–14.8, docs/32 §Б.10): объявление — назначаемый тип `notice`
 * (срок подтверждения — в назначении, CLAUDE.md п. 11), «Нагадати», простые объявления,
 * поиск по источникам с группами доступа, закладки, идемпотентный views_count, дни рождения,
 * события, гостевая страница и 404 чужого тенанта.
 */
const nt = await import('../../server/services/notices')
const hp = await import('../../server/services/hubPeople')
const hx = await import('../../server/services/hubExtra')
const kb = await import('../../server/services/knowledge')
const nw = await import('../../server/services/news')
const rs = await import('../../server/services/resources')
const { createAssignment } = await import('../../server/services/assignments')
const { findContent, listContent } = await import('../../server/services/taskContent')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string
let otherTenantId: string
let adminId: string
let lazarevaId: string
let segedskaId: string
let posId: string
const userIds: string[] = []
const cleanup: { table: string, ids: string[] }[] = []
const track = (table: string, id: string) => { (cleanup.find(c => c.table === table) ?? cleanup[cleanup.push({ table, ids: [] }) - 1]!).ids.push(id) }

async function makePerson(name: string, locationId: string, extra: Record<string, unknown> = {}) {
  const phone = `+38098${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users ${admin({ tenant_id: tenantId, phone, full_name: name, status: 'active', hired_at: new Date().toISOString().slice(0, 10), ...extra })} returning id`
  userIds.push(u!.id as string)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${locationId}, ${posId}, true)`
  await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type) select ${tenantId}, ${u!.id}, id, 'tenant' from roles where tenant_id = ${tenantId} and code = 'employee'`
  return u!.id as string
}
const ctx = (actorId = adminId) => ({ tenantId, actorId })
const text = (html: string) => [{ id: 'b', type: 'text' as const, html }]
const access = (scopes: string[]) => ({ userId: adminId, tenantId, grants: [{ scopes, scopeType: 'tenant' as const, scopeId: null }], activeRole: null, roles: [] })

async function assignNotice(noticeId: string, ids: string[], dueAt?: string) {
  const r = await createAssignment(ctx(), {
    subjectType: 'notice', subjectId: noticeId, lockVersion: false,
    audience: { rules: [{ type: 'user', ids }], match: 'any' },
    dueMode: dueAt ? 'absolute' : 'none', dueAt: dueAt ?? null, dueDays: 14, isMandatory: true, autoSync: true, tags: [], status: 'active',
  })
  if (!r.ok) throw new Error(r.code)
  track('assignments', r.assignmentId)
  return r.assignmentId
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  segedskaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Сегедська'`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-s21-${Date.now()}`}, 'barista-s21') returning id`)[0]!.id as string
  await admin`update locations set manager_id = ${adminId} where id = ${lazarevaId}`
  await admin`delete from notifications where user_id = ${adminId} and (code like 'birthday_%' or code = 'announcement_overdue_manager')`
  const [t] = await admin`insert into tenants (slug, name, status) values (${`s21-other-${Date.now()}`}, 'Інший', 'active') returning id`
  otherTenantId = t!.id as string
})

afterAll(async () => {
  for (const c of cleanup.reverse()) if (c.ids.length) await admin.unsafe(`delete from ${c.table} where id in (${c.ids.map(i => `'${i}'`).join(',')})`)
  if (userIds.length) { await admin`delete from notifications where user_id in ${admin(userIds)}`; await admin`delete from task_access_log where user_id in ${admin(userIds)}`; await admin`delete from users where id in ${admin(userIds)}` }
  await admin`delete from task_access_log where user_id = ${adminId} and content_type in ('news', 'notice', 'article', 'simple_notice')`
  await admin`delete from positions where id = ${posId}`
  await admin`update locations set manager_id = null where id = ${lazarevaId}`
  await admin`delete from tenants where id = ${otherTenantId}`
  await admin.end()
})

describe('объявление как назначаемый тип (docs/21 §14.5, docs/02 content_type=notice)', () => {
  it('назначение + подтверждение + охват + «Нагадати» + напоминание после срока', async () => {
    const a = await makePerson('Зміна А', lazarevaId)
    const b = await makePerson('Зміна Б', lazarevaId)
    const c = await makePerson('Інша точка', segedskaId)
    const n = await nt.createNotice(ctx(), { title: 'Нові правила видачі форми', body: text('<p>З 1 жовтня форма видається на точці.</p>'), kind: 'acknowledge', publish: true })
    track('notices', n.id)
    expect(n.status).toBe('published')

    // Контент типа notice виден назначению; черновик/архив — нет
    expect(await withTenant(tenantId, adminId, tx => findContent(tx, 'notice', n.id))).toMatchObject({ title: 'Нові правила видачі форми', summary: 'acknowledge' })
    expect((await listContent(ctx(), 'notice', 'видачі')).map(x => x.id)).toContain(n.id)

    // До назначения — никому не показывается и не подтверждается
    expect(await nt.pendingForUser(ctx(a))).toEqual([])
    expect(await nt.acknowledge(ctx(a), n.id)).toEqual({ ok: false, code: 'not_assigned' })

    // Срок подтверждения — в назначении (вчера), не в объявлении
    await assignNotice(n.id, [a, b], new Date(Date.now() - 3_600_000).toISOString())
    expect((await admin`select payload from notifications where user_id = ${a} and code = 'notice_assigned'`).length).toBe(1)
    expect((await nt.pendingForUser(ctx(a))).map(x => x.id)).toContain(n.id)
    expect((await nt.pendingForUser(ctx(c))).map(x => x.id)).not.toContain(n.id)
    expect(await nt.viewNotice(ctx(c), n.id)).toBeNull() // не назначено — 404
    expect((await nt.viewNotice(ctx(a), n.id))?.dueAt).toBeTruthy()

    let cov = await nt.coverage(ctx(), n.id)
    expect(cov).toMatchObject({ total: 2, acked: 0 })
    expect(cov!.byLocation.find(x => x.location === 'Лазарева')).toMatchObject({ total: 2, acked: 0, pct: 0 })

    // «Ознайомлений» — один тап, идемпотентно, с request_context
    const ack = await nt.acknowledge(ctx(a), n.id)
    expect(ack.ok).toBe(true)
    expect((await nt.acknowledge(ctx(a), n.id))).toMatchObject({ ok: true, ackedAt: (ack as { ackedAt: Date }).ackedAt })
    expect((await nt.pendingForUser(ctx(a))).map(x => x.id)).not.toContain(n.id)
    cov = await nt.coverage(ctx(), n.id)
    expect(cov?.acked).toBe(1)
    expect(cov?.readers.map(r => r.fullName)).toEqual(['Зміна А'])
    expect(cov?.notAcked.map(r => r.fullName)).toEqual(['Зміна Б'])
    expect((await nt.listMine(ctx(a))).find(x => x.id === n.id)?.ackedAt).toBeTruthy()

    // «Нагадати тим, хто не підтвердив»: только Б, раз в день, в аудите
    const rem = await nt.remind(ctx(), n.id)
    expect(rem).toMatchObject({ ok: true, reminded: 1, total: 1 })
    expect((await nt.remind(ctx(), n.id))).toMatchObject({ ok: true, reminded: 0, total: 1 })
    expect((await admin`select 1 from notifications where user_id = ${b} and code = 'notice_not_acknowledged'`).length).toBe(1)
    expect((await admin`select 1 from notifications where user_id = ${a} and code = 'notice_not_acknowledged'`).length).toBe(0)
    expect((await admin`select 1 from audit_log where entity_id = ${n.id} and action = 'notice.remind'`).length).toBe(2) // оба вызова — в аудите

    // Сканер: срок прошёл → руководителю точки список неподтвердивших
    const s = await nt.noticeScan(tenantId)
    expect(s.escalated).toBeGreaterThanOrEqual(1)
    const [esc] = await admin`select payload from notifications where user_id = ${adminId} and code = 'announcement_overdue_manager' and payload->>'title' = 'Нові правила видачі форми'`
    expect((esc!.payload as { names: string }).names).toContain('Зміна Б')

    // Список админки: «Ознайомились 1 із 2», режим призначення вручну
    const row = (await nt.listNotices(ctx())).find(x => x.id === n.id)
    expect(row).toMatchObject({ acks: 1, total: 2, assignMode: 'manual', phase: 'active' })
  })

  it('в таблице объявления нет срока: срок только у назначения', async () => {
    const cols = await admin`select column_name from information_schema.columns where table_name = 'notices'`
    expect(cols.map(c => c.column_name).filter(c => /due_at|attempts|pass_score|time_limit/.test(c as string))).toEqual([])
    expect((await admin`select 1 from information_schema.columns where table_name = 'news' and column_name = 'ack_due_at'`).length).toBe(0)
  })

  it('простое объявление: без назначения и подтверждения, просмотр раз в день', async () => {
    const s = await nt.createSimpleNotice(ctx(), { title: 'Технічні роботи в неділю', body: text('<p>З 02:00.</p>'), endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), publish: true })
    track('simple_notices', s.id)
    const emp = await makePerson('Читач плашки', lazarevaId)
    expect((await nt.listSimpleNotices(ctx(emp), { activeOnly: true })).map(x => x.id)).toContain(s.id)
    await nt.viewSimpleNotice(ctx(emp), s.id)
    await nt.viewSimpleNotice(ctx(emp), s.id)
    expect((await nt.listSimpleNotices(ctx())).find(x => x.id === s.id)?.viewsCount).toBe(1)
    await nt.updateSimpleNotice(ctx(), s.id, { endsAt: new Date(Date.now() - 1000).toISOString() })
    expect((await nt.listSimpleNotices(ctx(emp), { activeOnly: true })).map(x => x.id)).not.toContain(s.id)
  })
})

describe('поиск по источникам, группы доступа, закладки, views_count (docs/21 §14.1, docs/04 §4.13)', () => {
  it('источники resources | news | notices; ресурс вне группы доступа не виден даже заголовком', async () => {
    const stamp = Date.now()
    const emp = await makePerson('Пошукач', lazarevaId)
    const [grp] = await admin`insert into access_groups (tenant_id, name, applies_to) values (${tenantId}, ${`Офіс-s21-${stamp}`}, 'knowledge') returning id`
    track('access_groups', grp!.id as string)
    await admin`insert into access_group_members (tenant_id, group_id, subject_type, subject_id) values (${tenantId}, ${grp!.id}, 'user', ${adminId})`
    const base = { kind: 'article' as const, language: 'uk' as const, tags: [], categoryIds: [], allowPrint: true }
    const open = await rs.createResource(ctx(), { ...base, title: `Регламент харчування ${stamp}`, body: text('<p>Ліміти на зміну.</p>') })
    const closed = await rs.createResource(ctx(), { ...base, title: `Регламент харчування офісу ${stamp}`, body: text('<p>Тільки офіс.</p>'), accessGroupIds: [grp!.id as string] })
    track('resources', open.id); track('resources', closed.id)
    await rs.publishResource(ctx(), open.id, { notifyAssigned: false }); await rs.publishResource(ctx(), closed.id, { notifyAssigned: false })
    const news = await nw.createNews(ctx(), { title: `Регламент харчування: новина ${stamp}`, body: text('<p>Оновлено.</p>'), publish: true })
    track('news', news.id)
    const notice = await nt.createNotice(ctx(), { title: `Регламент харчування: оголошення ${stamp}`, body: text('<p>Ознайомтесь.</p>'), kind: 'acknowledge', publish: true })
    track('notices', notice.id)
    await assignNotice(notice.id, [emp])

    const q = `харчування ${stamp}` // слова ищутся по отдельности: заголовок «Регламент харчування: новина <stamp>» находится
    const all = await kb.search(ctx(emp), q, 20, 'all')
    expect(all.map(h => `${h.kind}:${h.id}`)).toEqual(expect.arrayContaining([`lesson:${open.id}`, `news:${news.id}`, `notice:${notice.id}`]))
    expect(all.map(h => h.id)).not.toContain(closed.id) // группа доступа: не показывается вовсе
    expect((await kb.search(ctx(), q, 20, 'resources')).map(h => h.id)).toContain(closed.id) // член группы видит
    const onlyNews = await kb.search(ctx(emp), q, 20, 'news')
    expect(onlyNews.map(h => h.kind)).toEqual(['news']); expect(onlyNews[0]?.id).toBe(news.id)
    expect((await kb.search(ctx(emp), q, 20, 'notices')).map(h => `${h.kind}:${h.id}`)).toEqual([`notice:${notice.id}`])
    const other = await makePerson('Не призначений', segedskaId)
    expect(await kb.search(ctx(other), q, 20, 'notices')).toEqual([])

    // Закладки: переключатель, список, отметка в поиске; несуществующее — not_found
    expect(await hx.toggleBookmark(ctx(emp), 'news', news.id)).toEqual({ ok: true, bookmarked: true })
    expect(await hx.toggleBookmark(ctx(emp), 'resource', open.id)).toEqual({ ok: true, bookmarked: true })
    expect((await hx.listBookmarks(ctx(emp))).map(b => b.title)).toEqual(expect.arrayContaining([news.title, open.title]))
    expect((await kb.search(ctx(emp), q, 20, 'news'))[0]?.bookmarked).toBe(true)
    expect(await hx.toggleBookmark(ctx(emp), 'news', news.id)).toEqual({ ok: true, bookmarked: false })
    expect(await hx.toggleBookmark(ctx(emp), 'news', '00000000-0000-0000-0000-000000000001')).toEqual({ ok: false, code: 'not_found' })

    // views_count: раз на человека в день
    await nw.getNews(ctx(emp), news.id); await nw.getNews(ctx(emp), news.id); await nw.getNews(ctx(), news.id)
    expect((await nw.listNews(ctx(), { all: true })).find(n => n.id === news.id)?.viewsCount).toBe(2)
    await nt.viewNotice(ctx(emp), notice.id); await nt.viewNotice(ctx(emp), notice.id)
    expect((await nt.getNotice(ctx(), notice.id))?.viewsCount).toBe(1)
    expect((await admin`select count(*)::int as n from task_access_log where user_id = ${emp} and content_type = 'notice' and content_id = ${notice.id}`)[0]!.n).toBe(2) // журнал — каждое открытие
  })
})

describe('дни рождения (29 Б.16), контакты (docs/21 §14.8), события (§3.4), гостевая (Г-21.3)', () => {
  it('дни рождения: две недели, согласие opt-out, скрытые не показываются; напоминание руководителю за 3 дня', async () => {
    const md = (offset: number) => { const d = new Date(Date.now() + offset * 86_400_000); return `1990-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}` }
    const soon = await makePerson('Іменинник', lazarevaId, { birth_date: md(3) })
    const past = await makePerson('Минулий', lazarevaId, { birth_date: md(-2) })
    const hidden = await makePerson('Прихований', lazarevaId, { birth_date: md(3), is_hidden: true })
    const refused = await makePerson('Без згоди', lazarevaId, { birth_date: md(5) })
    await hp.setBirthdayConsent(ctx(refused), false)
    expect((await admin`select birthday_consent from users where id = ${refused}`)[0]!.birthday_consent).toBe(false)

    const up = await hp.birthdays(ctx(), { tab: 'upcoming' })
    const ids = up.items.map(i => i.id)
    expect(ids).toContain(soon)
    expect(ids).not.toContain(past); expect(ids).not.toContain(hidden); expect(ids).not.toContain(refused)
    expect(up.items.find(i => i.id === soon)).toMatchObject({ location: 'Лазарева', position: expect.stringContaining('Бариста') })
    expect((await hp.birthdays(ctx(), { tab: 'past' })).items.map(i => i.id)).toContain(past)

    const s = await hp.birthdayScan(tenantId)
    expect(s.upcoming).toBeGreaterThanOrEqual(1)
    expect((await hp.birthdayScan(tenantId)).upcoming).toBe(0) // дедуп на год
    expect((await admin`select 1 from notifications where user_id = ${adminId} and code = 'birthday_upcoming' and payload->>'name' = 'Іменинник'`).length).toBe(1)
    expect((await admin`select 1 from notifications where code = 'birthday_upcoming' and payload->>'name' = 'Прихований'`).length).toBe(0)
  })

  it('контакты: рабочие поля всем, личные — по people.view или настройке тенанта', async () => {
    const p = await makePerson('Контактна Особа', lazarevaId, { email: 's21@example.com', work_contacts: { ext: '+380 66 200 00 01', workEmail: 'hr@example.com' } })
    const plain = await hp.contacts(ctx(p), access(['learn.view']), { q: 'Контактна' })
    expect(plain.showPersonal).toBe(false)
    expect(plain.items[0]).toMatchObject({ fullName: 'Контактна Особа', workPhone: '+380 66 200 00 01', workEmail: 'hr@example.com', location: 'Лазарева' })
    expect(plain.items[0]).not.toHaveProperty('email')
    const hr = await hp.contacts(ctx(), access(['learn.view', 'people.view']), { q: 'Контактна' })
    expect(hr.items[0]).toMatchObject({ email: 's21@example.com' })
    await admin`update users set is_hidden = true where id = ${p}`
    expect((await hp.contacts(ctx(), access(['learn.view']), { q: 'Контактна' })).items).toEqual([])
  })

  it('события: список Назва·Коли·Де·Запрошено, афиша только запрошенным, запись с гостями', async () => {
    const inv = await makePerson('Запрошений', lazarevaId)
    const out = await makePerson('Не запрошений', segedskaId)
    const e = await hx.createEvent(ctx(), { title: 'Загальні збори мережі', startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), locationId: lazarevaId, capacity: 3, registrationRequired: true, audienceLocationIds: [lazarevaId] })
    track('meetups', e.id)
    const row = (await hx.listEvents(ctx())).find(x => x.id === e.id)
    expect(row).toMatchObject({ locationName: 'Лазарева', published: true, registered: 0 })
    expect(row!.invited).toBeGreaterThanOrEqual(1)
    expect((await hx.listEventsForUser(ctx(inv))).map(x => x.id)).toContain(e.id)
    expect((await hx.listEventsForUser(ctx(out))).map(x => x.id)).not.toContain(e.id)
    expect(await hx.registerForEvent(ctx(out), e.id)).toEqual({ ok: false, code: 'not_found' })
    const r = await hx.registerForEvent(ctx(inv), e.id, 1)
    expect(r.ok).toBe(true)
    expect((await hx.listEvents(ctx())).find(x => x.id === e.id)?.registered).toBe(1)
  })

  it('гостевая страница: три блока по slug тенанта, чужой/неизвестный — null (404)', async () => {
    const blocks = await hx.setGuestBlocks(ctx(), { welcome: text('<p>Вітаємо!</p>'), supportContact: { name: 'HR', phone: '+380662000001' }, policyUrl: 'https://example.com/policy' })
    expect(blocks.supportContact.name).toBe('HR')
    const page = await hx.guestPage('kappi')
    expect(page).toMatchObject({ slug: 'kappi', blocks: { policyUrl: 'https://example.com/policy' } })
    expect(Object.keys(page!)).toEqual(['name', 'slug', 'blocks']) // ничего лишнего наружу
    expect(await hx.guestPage('no-such-tenant-xyz')).toBeNull()
    expect(await hx.guestPage('../etc')).toBeNull()
    expect(hx.slugFromHost('kappi.lola.app')).toBe('kappi')
    expect(hx.slugFromHost('localhost:3000')).toBeNull()
    expect(hx.slugFromHost('www.lola.app')).toBeNull()
    // Чужой тенант: объявление другого пространства — не найдено
    const [foreign] = await admin`insert into notices (tenant_id, title, body, kind, status) values (${otherTenantId}, 'Чуже', '[]', 'acknowledge', 'published') returning id`
    track('notices', foreign!.id as string)
    expect(await nt.getNotice(ctx(), foreign!.id as string)).toBeNull()
    expect(await nt.coverage(ctx(), foreign!.id as string)).toBeNull()
    expect(await hx.toggleBookmark(ctx(), 'notice', foreign!.id as string)).toEqual({ ok: false, code: 'not_found' })
  })
})
