import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Spec 10 (docs/10 §14.1–14.2; docs/32 §Б рядок 19): групи доступу каталогу, режими доступу
 * курсу (catalog_free/catalog_request), приймання заявок (схвалення → призначення з via_catalog),
 * лента коментарів з маршрутизацією.
 */

const { createCourse, addModule, addLesson, publishCourse } = await import('../../server/services/courses')
const { catalog, selfEnroll, requestEnrollment, decideCourseRequest } = await import('../../server/services/learning')
const { createAccessGroup, deleteAccessGroup } = await import('../../server/services/resources')
const { updateCatalogSettings } = await import('../../server/services/catalogAccess')
const { createComment, listComments, markCommentRead, replyToComment } = await import('../../server/services/comments')
const { listLearningRequests } = await import('../../server/services/learningRequests')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
let tenantId: string, adminId: string, lazarevaId: string, posId: string, otherPosId: string
const userIds: string[] = [], courseIds: string[] = [], groupIds: string[] = []
const ctx = (actorId = adminId) => ({ tenantId, actorId })
const stamp = Date.now()

async function makePerson(name: string, pos = posId) {
  const phone = `+38064${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, ${phone}, ${name}, 'active', current_date) returning id`
  userIds.push(u!.id as string)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${lazarevaId}, ${pos}, true)`
  return u!.id as string
}

async function makeCourse(title: string, opts: { isCatalogVisible: boolean, assignMode?: 'catalog_free' | 'catalog_request' }) {
  const c = await createCourse(ctx(), { title: `${title} ${stamp}`, language: 'uk', strictOrder: true, tags: [], ...opts })
  courseIds.push(c.id)
  const m = await addModule(ctx(), c.id, 'Р')
  await addLesson(ctx(), { moduleId: m!.id, title: 'Урок', itemType: 'resource', resource: { body: [{ id: 'b', type: 'text', html: '<p>x</p>' }] }, isRequired: true, videoThresholdPct: 90 })
  await publishCourse(ctx(), c.id, 'v1')
  return c.id
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-s10-${stamp}`}, ${`barista-s10-${stamp}`}) returning id`)[0]!.id as string
  otherPosId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Кухар-s10-${stamp}`}, ${`cook-s10-${stamp}`}) returning id`)[0]!.id as string
})

afterAll(async () => {
  await updateCatalogSettings(ctx(), { restrictAccess: false })
  if (groupIds.length) for (const id of groupIds) await deleteAccessGroup(ctx(), id)
  if (userIds.length) {
    await admin`delete from comments where author_id in ${admin(userIds)} or routed_to in ${admin(userIds)}`
    await admin`delete from notifications where user_id in ${admin(userIds)}`
    await admin`delete from enrollments where user_id in ${admin(userIds)}`
  }
  if (courseIds.length) await admin`delete from courses where id in ${admin(courseIds)}`
  if (userIds.length) await admin`delete from users where id in ${admin(userIds)}`
  await admin`delete from positions where id in ${admin([posId, otherPosId])}`
  await admin.end()
})

describe('групи доступу каталогу і режим доступу курсу (docs/10 §14.1)', () => {
  it('тумблер вимкнено (за замовчуванням) — курс з групою всеодно видно всім', async () => {
    const learner = await makePerson('Учень Каталог-1')
    const courseId = await makeCourse('Публічний курс', { isCatalogVisible: true, assignMode: 'catalog_free' })
    const list = await catalog(ctx(learner))
    expect(list.some(c => c.id === courseId)).toBe(true)
  })

  it('тумблер увімкнено — курс з групою бачить тільки той, хто входить у групу; інший — ні (сервер, не клієнт)', async () => {
    await updateCatalogSettings(ctx(), { restrictAccess: true })
    const inGroup = await makePerson('Учень Каталог-2', posId)
    const outGroup = await makePerson('Учень Каталог-3', otherPosId)
    const courseId = await makeCourse('Обмежений курс', { isCatalogVisible: true, assignMode: 'catalog_free' })
    const g = await createAccessGroup(ctx(), { name: `Група каталогу ${stamp}`, appliesTo: 'catalog', members: [{ subjectType: 'position', subjectId: posId }] })
    groupIds.push(g.id)
    await admin`insert into content_access_groups (tenant_id, content_type, content_id, group_id) values (${tenantId}, 'course', ${courseId}, ${g.id})`

    const visibleTo = await catalog(ctx(inGroup))
    expect(visibleTo.some(c => c.id === courseId)).toBe(true)
    const hiddenFrom = await catalog(ctx(outGroup))
    expect(hiddenFrom.some(c => c.id === courseId)).toBe(false)

    await admin`delete from content_access_groups where group_id = ${g.id}`
    await updateCatalogSettings(ctx(), { restrictAccess: false })
  })

  it('catalog_free — самозапис одразу; catalog_request — selfEnroll відхиляється, потрібна заявка', async () => {
    const learner = await makePerson('Учень Каталог-4')
    const freeId = await makeCourse('Вільний курс', { isCatalogVisible: true, assignMode: 'catalog_free' })
    const reqId = await makeCourse('Курс за заявкою', { isCatalogVisible: true, assignMode: 'catalog_request' })

    const free = await selfEnroll(ctx(learner), freeId)
    expect(free.ok).toBe(true)

    const denied = await selfEnroll(ctx(learner), reqId)
    expect(denied).toMatchObject({ ok: false, code: 'requires_request' })
  })
})

describe('приймання заявок на курс (docs/10 §14.1)', () => {
  it('заявка → схвалення створює призначення через tasks.ts з via_catalog, повторна заявка — already_requested', async () => {
    const learner = await makePerson('Учень Заявка-1')
    const courseId = await makeCourse('Курс із заявкою', { isCatalogVisible: true, assignMode: 'catalog_request' })

    const r1 = await requestEnrollment(ctx(learner), courseId, 'Хочу підвищити кваліфікацію')
    expect(r1.ok).toBe(true)
    if (!r1.ok) throw new Error('unreachable')

    const dup = await requestEnrollment(ctx(learner), courseId)
    expect(dup).toMatchObject({ ok: false, code: 'already_requested' })

    const pendingRow = (await admin`select status, requested_at, assignment_id from enrollments where id = ${r1.enrollmentId}`)[0]!
    expect(pendingRow.status).toBe('not_assigned')
    expect(pendingRow.requested_at).toBeTruthy()
    expect(pendingRow.assignment_id).toBeNull()

    const decision = await decideCourseRequest(ctx(), r1.enrollmentId, true)
    expect(decision).toEqual({ ok: true })

    const approved = (await admin`select status, assignment_id from enrollments where id = ${r1.enrollmentId}`)[0]!
    expect(approved.status).toBe('not_started')
    expect(approved.assignment_id).toBeTruthy()
    const assignment = (await admin`select kind, via_catalog from assignments where id = ${approved.assignment_id}`)[0]!
    expect(assignment).toMatchObject({ kind: 'catalog', via_catalog: true })

    const audit = await admin`select action from audit_log where entity = 'enrollment' and entity_id = ${r1.enrollmentId} and action = 'enrollment.request.approve'`
    expect(audit.length).toBeGreaterThan(0)

    // Повторне рішення по вже вирішеній заявці — not_requested
    const again = await decideCourseRequest(ctx(), r1.enrollmentId, true)
    expect(again).toMatchObject({ ok: false, code: 'not_requested' })
  })

  it('відмова без причини не проходить валідацію ендпоінта; сервіс приймає reason і зберігає його', async () => {
    const learner = await makePerson('Учень Заявка-2')
    const courseId = await makeCourse('Курс для відмови', { isCatalogVisible: true, assignMode: 'catalog_request' })
    const r = await requestEnrollment(ctx(learner), courseId)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')

    const decision = await decideCourseRequest(ctx(), r.enrollmentId, false, 'Немає вакансій на курс цього кварталу')
    expect(decision).toEqual({ ok: true })
    const row = (await admin`select status, cancelled_at, cancel_reason from enrollments where id = ${r.enrollmentId}`)[0]!
    expect(row.status).toBe('not_assigned')
    expect(row.cancelled_at).toBeTruthy()
    expect(row.cancel_reason).toBe('Немає вакансій на курс цього кварталу')

    const n = await admin`select payload from notifications where user_id = ${learner} and code = 'catalog_request_rejected'`
    expect(n.length).toBeGreaterThan(0)
  })

  it('черга адміну (learningRequests) бачить заявку на курс у вкладці tasks', async () => {
    const learner = await makePerson('Учень Заявка-3')
    const courseId = await makeCourse('Курс у черзі', { isCatalogVisible: true, assignMode: 'catalog_request' })
    const r = await requestEnrollment(ctx(learner), courseId)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')

    const rows = await listLearningRequests(ctx(), 'tasks')
    const found = rows.find(x => x.id === r.enrollmentId)
    expect(found).toMatchObject({ kind: 'course', status: 'pending', userId: learner })
  })
})

describe('лента коментарів з маршрутизацією (docs/10 §14.2)', () => {
  it('коментар до курсу маршрутизується автору курсу і надсилає сповіщення', async () => {
    const author = await makePerson('Автор Курсу')
    const learner = await makePerson('Учень Коментар')
    const c = await createCourse({ tenantId, actorId: author }, { title: `Курс з автором ${stamp}`, language: 'uk', strictOrder: true, tags: [], isCatalogVisible: false })
    courseIds.push(c.id)

    const comment = await createComment(ctx(learner), { sourceType: 'course', sourceId: c.id, body: 'Граммовки не відповідають матеріалам' })
    expect(comment.routedTo).toBe(author)
    expect(comment.isRead).toBe(false)

    const n = await admin`select payload from notifications where user_id = ${author} and code = 'comment_routed'`
    expect(n.length).toBeGreaterThan(0)

    const list = await listComments(ctx(author), { limit: 50 })
    expect(list.some(r => r.id === comment.id)).toBe(true)

    const read = await markCommentRead(ctx(author), comment.id)
    expect(read).toBe(true)
    const unreadOnly = await listComments(ctx(author), { isRead: 'unread', limit: 50 })
    expect(unreadOnly.some(r => r.id === comment.id)).toBe(false)

    const reply = await replyToComment(ctx(author), comment.id, 'Дякую, перевірю рецептуру')
    expect(reply.ok).toBe(true)
    const nReply = await admin`select payload from notifications where user_id = ${learner} and code = 'comment_replied'`
    expect(nReply.length).toBeGreaterThan(0)
  })

  it('фолбек на адміністратора (docs/33 D-062) пропускає прострочену роль і бере чинного', async () => {
    // Точка без керівника — форсуємо фолбек contentAuthor(self) → managerOf(null) → anyAdmin()
    const [loc] = await admin`insert into locations (tenant_id, org_unit_id, name, address) values (${tenantId}, (select id from org_units where tenant_id = ${tenantId} and parent_id is null limit 1), ${`Без керівника ${stamp}`}, 'вул. Тестова') returning id`
    const locId = loc!.id as string
    const phone = `+38064${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
    const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, ${phone}, 'Учень Без Керівника', 'active', current_date) returning id`
    const learner = u!.id as string
    userIds.push(learner)
    await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${learner}, ${locId}, ${posId}, true)`

    // Курс автора-себе — гілка «автор» пропускається (author === actorId), йде далі по ланцюжку
    const c = await createCourse({ tenantId, actorId: learner }, { title: `Курс без автора ${stamp}`, language: 'uk', strictOrder: true, tags: [], isCatalogVisible: false })
    courseIds.push(c.id)

    // Прострочена роль адміністратора — не має обиратись фолбеком
    const [adminRole] = await admin`select id from roles where tenant_id = ${tenantId} and code = 'admin'`
    const [expired] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, ${`+38066${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`}, 'Прострочений Адмін', 'active', current_date) returning id`
    const expiredAdminId = expired!.id as string
    userIds.push(expiredAdminId)
    await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type, valid_until) values (${tenantId}, ${expiredAdminId}, ${adminRole!.id}, 'tenant', now() - interval '1 day')`

    const comment = await createComment(ctx(learner), { sourceType: 'course', sourceId: c.id, body: 'Немає керівника точки — куди піде коментар?' })
    expect(comment.routedTo).toBe(adminId)
    expect(comment.routedTo).not.toBe(expiredAdminId)

    await admin`delete from user_roles where user_id = ${expiredAdminId} and role_id = ${adminRole!.id}`
    await admin`delete from user_placements where user_id = ${learner} and location_id = ${locId}`
    await admin`delete from locations where id = ${locId}`
  })

  it('чужий тенант — 404 для рішення по заявці на курс', async () => {
    const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
    const otherTenantId = other!.id as string
    const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${otherTenantId}, ${`+38065${stamp}`}, 'Чужий учень', 'active', current_date) returning id`
    const [c] = await admin`insert into courses (tenant_id, title, slug, status, is_catalog_visible) values (${otherTenantId}, 'Чужий курс', ${`foreign-s10-${stamp}`}, 'published', true) returning id`
    const [v] = await admin`insert into course_versions (tenant_id, course_id, version, status) values (${otherTenantId}, ${c!.id}, 1, 'published') returning id`
    await admin`update courses set published_version_id = ${v!.id} where id = ${c!.id}`
    const [foreignEnrollment] = await admin`insert into enrollments (tenant_id, user_id, subject_id, version_id, source, status, requested_at)
      values (${otherTenantId}, ${u!.id}, ${c!.id}, ${v!.id}, 'catalog', 'not_assigned', now()) returning id`

    const r = await decideCourseRequest(ctx(), foreignEnrollment!.id as string, true)
    expect(r).toMatchObject({ ok: false, code: 'not_found' })

    await admin`delete from enrollments where id = ${foreignEnrollment!.id}`
    await admin`delete from course_versions where id = ${v!.id}`
    await admin`delete from courses where id = ${c!.id}`
    await admin`delete from users where id = ${u!.id}`
  })
})
