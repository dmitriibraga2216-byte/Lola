import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * docs/33 D-063 (докс/28 §28.4, клас «в»): єдиний `/content*` над одинадцятьма типами
 * контента — вітрина-агрегатор поверх існуючих сервісів (`server/services/contentCatalog.ts`),
 * видимість типу — по тому самому скоупу, що й у власного CRUD цього типу.
 */
process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { createCourse } = await import('../../server/services/courses')
const { createResource } = await import('../../server/services/resources')
const { listAllContent, CONTENT_CATALOG_TYPES } = await import('../../server/services/contentCatalog')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
let tenantId: string
let adminId: string
const ctx = () => ({ tenantId, actorId: adminId })
const stamp = Date.now()
const courseIds: string[] = []
const resourceIds: string[] = []

function access(scopes: string[]) {
  return { userId: adminId, tenantId, grants: [{ scopes, scopeType: 'tenant' as const, scopeId: null }], activeRole: null, roles: [] }
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
})

afterAll(async () => {
  if (courseIds.length) await admin`delete from courses where id in ${admin(courseIds)}`
  if (resourceIds.length) await admin`delete from resources where id in ${admin(resourceIds)}`
  await admin.end()
})

describe('docs/33 D-063 — вітрина /content над 11 типами', () => {
  it('повертає курс і ресурс лише тому, у кого є скоуп «рідного» CRUD цього типу; тип без скоупу — відсутній', async () => {
    const c = await createCourse(ctx(), { title: `Вітрина курс ${stamp}`, language: 'uk', strictOrder: true, isCatalogVisible: false, tags: [] })
    courseIds.push(c.id)
    const r = await createResource(ctx(), { title: `Вітрина ресурс ${stamp}`, kind: 'article', language: 'uk', tags: [], categoryIds: [], allowPrint: true, body: [{ id: 'b', type: 'text', html: '<p>x</p>' }] })
    resourceIds.push(r.id)

    // course.view бачить і курс, і ресурс (обидва на цьому скоупі, докс/28 §28.4), але не бачить типи інших скоупів
    const withCourseView = await listAllContent(access(['course.view']), { q: `${stamp}` })
    expect(withCourseView.items.map(i => i.contentType).sort()).toEqual(['course', 'resource'])
    expect(withCourseView.items.find(i => i.id === c.id)).toMatchObject({ contentType: 'course', title: `Вітрина курс ${stamp}` })
    expect(withCourseView.items.find(i => i.id === r.id)).toMatchObject({ contentType: 'resource', title: `Вітрина ресурс ${stamp}` })

    // зовсім без скоупів витрини — порожньо
    const withNothing = await listAllContent(access([]), { q: `${stamp}` })
    expect(withNothing.items).toEqual([])
    expect(withNothing.total).toBe(0)

    // фільтр за типом звужує навіть у того, хто бачить обидва
    const onlyResource = await listAllContent(access(['course.view']), { q: `${stamp}`, type: 'resource' })
    expect(onlyResource.items.map(i => i.contentType)).toEqual(['resource'])
  })

  it('11 типів визначено (без notice — у нього свій список, докс/21 §14.5)', () => {
    expect(CONTENT_CATALOG_TYPES.sort()).toEqual([
      'assessment', 'check_list', 'complex_test', 'course', 'meetup', 'poll', 'resource', 'test', 'training_program', 'webinar', 'workshop',
    ].sort())
  })
})
