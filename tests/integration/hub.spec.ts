import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const nw = await import('../../server/services/news')
const wk = await import('../../server/services/wiki')
const rb = await import('../../server/services/reportBuilder')
const org = await import('../../server/services/orgTree')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string
let adminId: string
let lazarevaId: string
let segedskaId: string
let posId: string
const userIds: string[] = []
const newsIds: string[] = []
const pageIds: string[] = []
const reportIds: string[] = []

async function makePerson(name: string, locationId: string, roleCode?: string) {
  const phone = `+38099${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, ${phone}, ${name}, 'active', current_date) returning id`
  userIds.push(u!.id as string)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${locationId}, ${posId}, true)`
  if (roleCode) await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type) select ${tenantId}, ${u!.id}, id, 'tenant' from roles where tenant_id = ${tenantId} and code = ${roleCode}`
  return u!.id as string
}
const ctx = (actorId = adminId) => ({ tenantId, actorId })
const text = (html: string) => [{ id: 'b', type: 'text' as const, html }]

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  segedskaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Сегедська'`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-hub-${Date.now()}`}, 'barista-hub') returning id`)[0]!.id as string
  await admin`update locations set manager_id = ${adminId} where id = ${lazarevaId}`
})

afterAll(async () => {
  if (newsIds.length) await admin`delete from news where id in ${admin(newsIds)}`
  if (pageIds.length) await admin`delete from wiki_pages where id in ${admin(pageIds)}`
  if (reportIds.length) await admin`delete from saved_reports where id in ${admin(reportIds)}`
  if (userIds.length) { await admin`delete from notifications where user_id in ${admin(userIds)}`; await admin`delete from users where id in ${admin(userIds)}` }
  await admin`delete from positions where id = ${posId}`
  await admin`update locations set manager_id = null where id = ${lazarevaId}`
  await admin.end()
})

describe('этап 10: объявления (приёмка: доходит до 100% смены, видно кто прочитал)', () => {
  it('объявление для смены точки: показывается при входе, до подтверждения не исчезает, отчёт по точкам и поимённо', async () => {
    const a = await makePerson('Зміна А', lazarevaId)
    const b = await makePerson('Зміна Б', lazarevaId)
    const c = await makePerson('Інша точка', segedskaId)
    const n = await nw.createNews(ctx(), { title: 'Нові правила відкриття зміни', body: text('<p>З понеділка відкриваємо о 7:30.</p>'), kind: 'announcement', ackDueAt: new Date(Date.now() - 3_600_000).toISOString(), audience: { rules: [{ type: 'user', ids: [a, b] }], match: 'any' }, publish: true })
    newsIds.push(n.id)
    expect(n.requiresAck).toBe(true)

    // При входе — у смены Лазаревой висит, у другой точки нет
    expect((await nw.pendingAnnouncements(ctx(a))).map(x => x.id)).toContain(n.id)
    expect((await nw.pendingAnnouncements(ctx(c))).map(x => x.id)).not.toContain(n.id)

    // Просмотр ≠ подтверждение
    await nw.getNews(ctx(a), n.id)
    expect((await nw.pendingAnnouncements(ctx(a))).map(x => x.id)).toContain(n.id)
    let rep = await nw.announcementReport(ctx(), n.id)
    expect(rep).toMatchObject({ total: 2, viewed: 1, acked: 0 })
    expect(rep!.byLocation.find(x => x.location === 'Лазарева')).toMatchObject({ total: 2, acked: 0, pct: 0 })

    // Подтверждение
    await nw.ackNews(ctx(a), n.id)
    expect((await nw.pendingAnnouncements(ctx(a))).map(x => x.id)).not.toContain(n.id)
    rep = await nw.announcementReport(ctx(), n.id)
    expect(rep?.acked).toBe(1)
    expect((rep?.readers ?? []).map(r => r.fullName)).toEqual(['Зміна А'])
    expect((rep?.notAcked ?? []).map(r => r.fullName)).toEqual(['Зміна Б'])

    // Сканер: напоминание Б, срок прошёл → руководителю список
    const s = await nw.announcementScan(tenantId)
    expect(s.reminded).toBeGreaterThanOrEqual(1)
    expect(s.escalated).toBeGreaterThanOrEqual(1)
    const [esc] = await admin`select payload from notifications where user_id = ${adminId} and code = 'announcement_overdue_manager' and payload->>'title' = 'Нові правила відкриття зміни'`
    expect((esc!.payload as { names: string }).names).toContain('Зміна Б')

    await nw.ackNews(ctx(b), n.id)
    rep = await nw.announcementReport(ctx(), n.id)
    expect((rep?.byLocation ?? []).find(x => x.location === 'Лазарева')?.pct).toBe(100)
  })
})

describe('этап 10: wiki с историей и правами по веткам', () => {
  it('иерархия, ревизии, восстановление, права ветки', async () => {
    const emp = await makePerson('Читач', lazarevaId, 'employee')
    const mgr = await makePerson('Менеджер wiki', lazarevaId, 'manager')
    const root = await wk.createPage(ctx(), { title: `Стандарти ${Date.now()}`, body: text('<p>Кореневий розділ</p>') })
    if ('forbidden' in root) throw new Error('forbidden')
    pageIds.push(root.id)
    const child = await wk.createPage(ctx(), { title: 'Для керівників', body: text('<p>v1</p>'), parentId: root.id, viewRoles: ['manager', 'admin'], editRoles: ['manager'] })
    if ('forbidden' in child) throw new Error('forbidden')
    pageIds.push(child.id)
    expect(child.slug).toMatch(/^dlya-kerivnykiv|^dlia|^[a-z0-9-]+$/)

    // Сотрудник не видит ветку руководителей ни в дереве, ни по прямой ссылке
    expect((await wk.wikiTree(ctx(emp))).map(p => p.id)).not.toContain(child.id)
    expect(await wk.getPage(ctx(emp), child.id)).toMatchObject({ forbidden: true })
    expect((await wk.wikiTree(ctx(mgr))).map(p => p.id)).toContain(child.id)
    // Сотрудник не может править корень (нет wiki.edit), менеджер может править свою ветку
    expect(await wk.updatePage(ctx(emp), root.id, { body: text('<p>hack</p>') })).toMatchObject({ forbidden: true })
    const v2 = await wk.updatePage(ctx(mgr), child.id, { body: text('<p>v2</p>'), comment: 'уточнення' })
    expect(v2).toMatchObject({ version: 2 })
    // Правка прав без контента — версия не растёт
    expect(await wk.updatePage(ctx(), child.id, { sort: 5 })).toMatchObject({ version: 2 })
    const hist = await wk.pageHistory(ctx(mgr), child.id)
    expect(hist.map(h => h.version)).toEqual([2, 1])
    expect(hist[0]!.comment).toBe('уточнення')
    const restored = await wk.restoreRevision(ctx(mgr), child.id, 1)
    expect(restored).toMatchObject({ version: 3 })
    const page = await wk.getPage(ctx(mgr), child.id)
    expect(page && 'crumbs' in page ? page.crumbs.map(c => c.id) : []).toEqual([root.id])
    expect(page && 'body' in page ? (page.body as { html: string }[])[0]!.html : '').toContain('v1')
    // Поиск — с учётом прав
    expect((await wk.searchWiki(ctx(emp), 'Кореневий')).map(r => r.id)).toContain(root.id)
    expect((await wk.searchWiki(ctx(emp), 'v1')).map(r => r.id)).not.toContain(child.id)
    // Удаление ветки целиком
    expect(await wk.deletePage(ctx(), root.id)).toMatchObject({ deleted: 2 })
  })
})

describe('этап 10: оргструктура и конструктор отчётов', () => {
  it('публичное дерево содержит точки с людьми и руководителем', async () => {
    const t = await org.orgTree(ctx())
    const flat = JSON.stringify(t.units)
    expect(flat).toContain('Лазарева')
    expect(flat).toContain('Зміна А')
    expect(t.totals?.locations).toBeGreaterThanOrEqual(2)
  })

  it('отчёт по людям с фильтром по точке и группировкой; сохранение с расписанием; xlsx', async () => {
    const rows = await rb.runReport(ctx(), { entity: 'people', fields: ['full_name', 'location', 'position', 'courses_done'], filters: { location_id: lazarevaId } })
    expect(rows.some(r => r.full_name === 'Зміна А')).toBe(true)
    expect(rows.every(r => r.location === 'Лазарева')).toBe(true)
    const grouped = await rb.runReport(ctx(), { entity: 'people', fields: ['location', 'courses_done'], groupBy: 'location' })
    expect(grouped.find(g => g.location === 'Лазарева')!.rows).toBeGreaterThanOrEqual(4)
    // Неизвестное поле игнорируется, а не попадает в SQL
    expect(await rb.runReport(ctx(), { entity: 'people', fields: ['full_name; drop table users'] })).toEqual([])

    const saved = await rb.saveReport(ctx(), { name: `Зміна Лазарева ${Date.now()}`, spec: { entity: 'people', fields: ['full_name', 'position'], filters: { location_id: lazarevaId } }, schedule: { every: 'daily', hour: 9, channel: 'telegram', recipients: [adminId] } })
    reportIds.push(saved!.id)
    const x = await rb.savedToXlsx(ctx(), saved!.id)
    expect(x!.buffer.length).toBeGreaterThan(1000)
    // Расписание: в 9:00 Киева — уходит, второй раз в тот же день — нет
    const at9 = new Date(); at9.setUTCHours(6, 5, 0, 0) // 09:05 Kyiv (UTC+3)
    expect(await rb.scheduledReportsScan(tenantId, at9)).toBe(1)
    expect(await rb.scheduledReportsScan(tenantId, at9)).toBe(0)
    const [n] = await admin`select count(*)::int as c from notifications where user_id = ${adminId} and code = 'scheduled_report' and payload->>'name' = ${saved!.name}`
    expect(n!.c).toBe(1)
  })
})
