import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Регрессия security-sweep-2 (docs/v2/46-progress.md, «Аудит безопасности»): пользовательский текст,
 * который страницы рендерят как HTML. Каждый тест — находка, воспроизведённая до исправления.
 */

const { createVacancy } = await import('../../server/services/vacancies')
const wiki = await import('../../server/services/wiki')
const { renderTemplate } = await import('../../server/services/notifications')
const { toCsv } = await import('../../server/services/reportExports')
const { vacancyPublicationCreateSchema } = await import('../../shared/schemas/vacancies')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()
let tenantId: string, adminId: string
const ctx = () => ({ tenantId, actorId: adminId })
const vacancyIds: string[] = []
const pageIds: string[] = []
const PAYLOAD = '<img src=x onerror=alert(1)>'

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
})

afterAll(async () => {
  if (vacancyIds.length) {
    await admin`delete from audit_log where entity_id in ${admin(vacancyIds)}`
    await admin`delete from vacancies where id in ${admin(vacancyIds)}`
  }
  if (pageIds.length) {
    await admin`delete from audit_log where entity_id in ${admin(pageIds)}`
    await admin`delete from wiki_revisions where page_id in ${admin(pageIds)}`
    await admin`delete from wiki_pages where id in ${admin(pageIds)}`
  }
  await admin.end()
})

describe('HTML вакансии (публичная страница /j/<token>)', () => {
  it('обработчики событий и скрипты вырезаются при сохранении', async () => {
    const v = await createVacancy(ctx(), {
      title: `XSS ${stamp}`, salaryCurrency: 'UAH', salaryVisible: false, publicApplyOtp: false, applyDailyCap: 10,
      descriptionHtml: `${PAYLOAD}<p>Опис</p><script>alert(2)</script>`,
      assignmentTemplate: { dueMode: 'relative', dueDays: 7, isMandatory: true, params: {}, reminders: {}, notifyOnAssign: false },
    } as Parameters<typeof createVacancy>[1])
    vacancyIds.push(v.id)
    const [row] = await admin`select description_html from vacancies where id = ${v.id}`
    const html = String(row!.description_html)
    expect(html).toContain('<p>Опис</p>')
    expect(html).not.toMatch(/onerror|<script|<img/i)
  })

  it('ссылка ручной публикации — только http(s)', () => {
    const base = { confirm: true, manual: { accountId: '00000000-0000-4000-8000-000000000000' } }
    expect(vacancyPublicationCreateSchema.safeParse({ ...base, manual: { ...base.manual, externalUrl: 'javascript:alert(1)' } }).success).toBe(false)
    expect(vacancyPublicationCreateSchema.safeParse({ ...base, manual: { ...base.manual, externalUrl: 'https://work.ua/jobs/1' } }).success).toBe(true)
  })
})

describe('сниппет поиска вики (v-html ради <b>)', () => {
  it('сырой текст заголовка экранирован, подсветка — только <b>', async () => {
    const word = `zebra${stamp}`
    const page = await wiki.createPage(ctx(), { title: `Сторінка ${stamp}`, status: 'published', body: [{ id: 'h1', type: 'heading', level: 2, text: `${PAYLOAD} ${word}` }] as never })
    pageIds.push((page as { id: string }).id)
    const hits = await wiki.searchWiki(ctx(), word)
    expect(hits.length).toBeGreaterThan(0)
    const snippet = hits[0]!.snippet
    expect(snippet).not.toContain('<img')
    expect(snippet).toContain('&lt;img')
    expect(snippet.replace(/<\/?b>/g, '')).not.toMatch(/</)
  })
})

describe('письма и выгрузки', () => {
  it('подстановки в HTML письма экранируются, в тексте — нет', () => {
    const vars = { name: '<a href="https://evil.example">Увійти</a>' }
    expect(renderTemplate('<mj-text>Привіт, {{name}}</mj-text>', vars, undefined, 'uk', { html: true })).not.toContain('<a href')
    expect(renderTemplate('Привіт, {{name}}', vars)).toContain('<a href')
  })

  it('CSV: строка-формула гасится апострофом, число — нет', () => {
    const csv = toCsv([{ name: '=HYPERLINK("https://evil.example","x")', score: -5 }]).toString('utf-8')
    expect(csv).toContain(`"'=HYPERLINK(`)
    expect(csv).toContain(';-5')
  })
})
