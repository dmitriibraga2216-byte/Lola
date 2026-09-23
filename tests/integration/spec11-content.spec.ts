import 'dotenv/config'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { backdateOpen, readThrough } from './_lesson'

/**
 * Spec 11 (docs/11 §3.1, §14, Г-11.3–Г-11.5; docs/32 Б.7): ресурс с версиями, категориями и доступом;
 * раздел курса обязателен; tick {seconds, scrollPct, videoPct} и правила зачёта по типу; анти-накрутка;
 * notifyAssigned при публикации; лимиты файлов; чужой тенант — пусто/404.
 */
const {
  createResource, updateResource, publishResource, getResource, listResources, listResourceVersions, deleteResource, duplicateResource, setResourceStatus,
  listResourceCategories, createResourceCategory, reorderResourceCategories, deleteResourceCategory,
  createAccessGroup, listAccessGroups, canAccessResource, viewResource, printAllowed,
} = await import('../../server/services/resources')
const { createCourse, addModule, addLesson, publishChecks, publishCourse, getCourseEditor, updateLesson } = await import('../../server/services/courses')
const { selfEnroll, enrollmentTree, openLesson, tickLesson, completeLesson, acknowledgeLesson, markDownloaded } = await import('../../server/services/learning')
const { evaluateLesson, readingSeconds, documentSeconds } = await import('../../server/services/lessonRules')
const { checkFileLimits, MEDIA_LIMITS_MB } = await import('../../server/services/media')
const { findContent } = await import('../../server/services/taskContent')
const { withTenant } = await import('../../server/utils/withTenant')
const { createAssignment } = await import('../../server/services/assignments')
const { listChanged } = await import('../../server/services/tasks')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()

let tenantId: string
let otherTenantId: string
let authorId: string
let learnerId: string
let mentorId: string
const resourceIds: string[] = []
const courseIds: string[] = []
const assignmentIds: string[] = []
const mediaIds: string[] = []
const groupIds: string[] = []
const categoryIds: string[] = []

const author = () => ({ tenantId, actorId: authorId })
const learner = () => ({ tenantId, actorId: learnerId })
const text = (html: string, id = 'b1') => [{ id, type: 'text' as const, html }]
const base = { language: 'uk' as const, tags: [] as string[], categoryIds: [] as string[], allowPrint: true, body: [] as never[] }

async function media(kind: 'video' | 'file', status = 'ready', variants: Record<string, number> = {}) {
  const [m] = await admin`insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status, variants, owner_user_id)
    values (${tenantId}, ${`t/${tenantId}/test/${crypto.randomUUID()}.${kind === 'video' ? 'mp4' : 'pdf'}`}, ${kind === 'video' ? 'v.mp4' : 'doc.pdf'}, ${kind}, ${kind === 'video' ? 'video/mp4' : 'application/pdf'}, 1000, ${status}, ${admin.json(variants)}, ${authorId})
    returning id`
  mediaIds.push(m!.id as string)
  return m!.id as string
}

async function makeResource(over: Partial<Parameters<typeof createResource>[1]> & { title: string }) {
  const r = await createResource(author(), { kind: 'article', ...base, ...over })
  resourceIds.push(r.id)
  return r
}

beforeAll(async () => {
  const [t] = await admin`select id from tenants where slug = 'kappi'`
  tenantId = t!.id as string
  const pick = async (phone: string) => (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id as string
  authorId = await pick('+380661864742')
  mentorId = await pick('+380670000002')
  learnerId = await pick('+380670000003')
  const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = other!.id as string
})

afterAll(async () => {
  if (assignmentIds.length) await admin`delete from assignments where id in ${admin(assignmentIds)}`
  if (courseIds.length) {
    await admin`delete from certificates where course_id in ${admin(courseIds)}`
    await admin`delete from enrollments where subject_id in ${admin(courseIds)}`
    await admin`delete from courses where id in ${admin(courseIds)}`
  }
  await admin`delete from resources where tenant_id = ${tenantId} and title like ${`%s11-${stamp}%`}`
  if (mediaIds.length) await admin`delete from media_assets where id in ${admin(mediaIds)}`
  if (groupIds.length) await admin`delete from access_groups where id in ${admin(groupIds)}`
  if (categoryIds.length) await admin`delete from resource_categories where id in ${admin(categoryIds)}`
  await admin`delete from notifications where tenant_id = ${tenantId} and dedup_key like ${`content_%:${stamp}%`}`
  await admin.end()
})

describe('ресурс: версии (Г-11.3)', () => {
  let id: string

  it('создаётся черновиком, публикация делает снимок версии 1', async () => {
    const r = await makeResource({ title: `Сторінка s11-${stamp}`, body: text('<p>Перед видачею звіряємо три речі.</p>') })
    id = r.id
    expect(r.status).toBe('draft')
    expect(r.publishedVersionId).toBeNull()
    expect(await withTenant(tenantId, authorId, tx => findContent(tx, 'resource', id))).toBeNull() // черновик не назначается

    const pub = await publishResource(author(), id, { notifyAssigned: false })
    expect(pub.ok).toBe(true)
    if (pub.ok) expect(pub.version).toBe(1)
    const full = await getResource(author(), id)
    expect(full!.status).toBe('published')
    expect(full!.versions).toHaveLength(1)
    expect(full!.hasUnpublishedChanges).toBe(false)
    const found = await withTenant(tenantId, authorId, tx => findContent(tx, 'resource', id))
    expect(found?.title).toContain('Сторінка s11')
  })

  it('правка не меняет опубликованную версию, повторная публикация — версия 2', async () => {
    const upd = await updateResource(author(), id, { body: text('<p>Новий текст.</p>') })
    expect(upd.ok).toBe(true)
    expect((await getResource(author(), id))!.hasUnpublishedChanges).toBe(true)
    const view = await viewResource(learner(), id)
    expect(JSON.stringify(view!.body)).toContain('три речі') // ученик видит снимок

    const pub = await publishResource(author(), id, { changelog: 'Уточнили формулювання', notifyAssigned: false })
    expect(pub.ok && pub.version).toBe(2)
    const versions = await listResourceVersions(author(), id)
    expect(versions!.map(v => v.version)).toEqual([2, 1])
    expect(versions![0]!.changelog).toBe('Уточнили формулювання')
    expect(JSON.stringify((await viewResource(learner(), id))!.body)).toContain('Новий текст')
  })

  it('ссылка без адреса и файл с необработанным медиа не публикуются', async () => {
    const link = await makeResource({ title: `Посилання s11-${stamp}`, kind: 'link' })
    const pub = await publishResource(author(), link.id, { notifyAssigned: false })
    expect(pub.ok).toBe(false)
    if (!pub.ok) expect(pub.checks?.find(c => c.code === 'kind_complete')?.ok).toBe(false)

    const processing = await media('video', 'processing')
    const video = await makeResource({ title: `Відео s11-${stamp}`, kind: 'video', mediaId: processing })
    const pub2 = await publishResource(author(), video.id, { notifyAssigned: false })
    expect(pub2.ok).toBe(false)
    if (!pub2.ok) expect(pub2.checks?.find(c => c.code === 'media_ready')?.ok).toBe(false)
  })

  it('архив → чернетка; копия; удаление используемого запрещено', async () => {
    const archived = await setResourceStatus(author(), id, 'archived')
    expect(archived!.status).toBe('archived')
    expect((await updateResource(author(), id, { title: 'x'.repeat(5) })).ok).toBe(false)
    expect((await setResourceStatus(author(), id, 'draft'))!.status).toBe('draft')
    await publishResource(author(), id, { notifyAssigned: false })

    const copy = await duplicateResource(author(), id)
    expect(copy!.title).toContain('(копія)')
    expect(copy!.status).toBe('draft')
    resourceIds.push(copy!.id)

    const list = await listResources(author(), { status: 'all', q: `s11-${stamp}`, page: 1, perPage: 25 })
    expect(list.total).toBeGreaterThanOrEqual(4)
    expect(list.items.find(i => i.id === id)?.usedInCourses).toBe(0)
  })
})

describe('категории ресурсов и группы доступа', () => {
  it('категории: порядок перетаскиванием, счётчик ресурсов, удаление чистит ссылки', async () => {
    const a = await createResourceCategory(author(), { name: `Кухня s11-${stamp}` })
    const b = await createResourceCategory(author(), { name: `Офіс s11-${stamp}` })
    categoryIds.push(a.id, b.id)
    expect(b.sortOrder).toBeGreaterThan(a.sortOrder)
    await reorderResourceCategories(author(), [b.id, a.id])
    const ordered = (await listResourceCategories(author())).filter(c => categoryIds.includes(c.id))
    expect(ordered.map(c => c.id)).toEqual([b.id, a.id])

    const r = await makeResource({ title: `У категорії s11-${stamp}`, categoryIds: [a.id, b.id], body: text('<p>x</p>') })
    expect((await listResourceCategories(author())).find(c => c.id === a.id)!.resourcesCount).toBe(1)
    const byCat = await listResources(author(), { status: 'all', categoryId: a.id, page: 1, perPage: 25 })
    expect(byCat.items.map(i => i.id)).toContain(r.id)

    expect(await deleteResourceCategory(author(), a.id)).toBe(true)
    expect((await getResource(author(), r.id))!.categoryIds).toEqual([b.id])
  })

  it('доступ: без групп — всем; с группой — по роли/лично; автор — всегда', async () => {
    const [role] = await admin`select id from roles where tenant_id = ${tenantId} and code = 'mentor'`
    const g = await createAccessGroup(author(), { name: `Наставники s11-${stamp}`, appliesTo: 'knowledge', members: [{ subjectType: 'role', subjectId: role!.id as string }] })
    groupIds.push(g.id)
    expect((await listAccessGroups(author(), 'knowledge')).find(x => x.id === g.id)!.members).toHaveLength(1)

    const open = await makeResource({ title: `Відкритий s11-${stamp}`, body: text('<p>x</p>') })
    const closed = await makeResource({ title: `Закритий s11-${stamp}`, body: text('<p>x</p>'), accessGroupIds: [g.id] })
    await publishResource(author(), open.id, { notifyAssigned: false })
    await publishResource(author(), closed.id, { notifyAssigned: false })

    await withTenant(tenantId, authorId, async (tx) => {
      expect(await canAccessResource(tx, learnerId, open.id)).toBe(true)
      expect(await canAccessResource(tx, learnerId, closed.id)).toBe(false)
      expect(await canAccessResource(tx, mentorId, closed.id)).toBe(true) // по роли
      expect(await canAccessResource(tx, authorId, closed.id)).toBe(true) // автор
    })
    expect(await viewResource(learner(), closed.id)).toBeNull() // нет доступа — 404

    await updateResource(author(), closed.id, { accessGroupIds: [] })
    const g2 = await createAccessGroup(author(), { name: `Особисто s11-${stamp}`, appliesTo: 'knowledge', members: [{ subjectType: 'user', subjectId: learnerId }] })
    groupIds.push(g2.id)
    await updateResource(author(), closed.id, { accessGroupIds: [g2.id] })
    const view = await viewResource(learner(), closed.id)
    expect(view).not.toBeNull()
    expect(view!.canPrint).toBe(true)
    expect((await getResource(author(), closed.id))!.viewsCount).toBe(1)
  })

  it('«Дозволити друк» и политика «Вимкнути друк у ресурсах»', async () => {
    await withTenant(tenantId, authorId, async (tx) => {
      expect(await printAllowed(tx, tenantId, true)).toBe(true)
      expect(await printAllowed(tx, tenantId, false)).toBe(false)
    })
    await admin`update tenants set settings = settings || '{"policies":{"dataProtection":{"disablePrint":true}}}'::jsonb where id = ${tenantId}`
    try {
      await withTenant(tenantId, authorId, async (tx) => {
        expect(await printAllowed(tx, tenantId, true)).toBe(false)
      })
    }
    finally {
      await admin`update tenants set settings = settings - 'policies' where id = ${tenantId}`
    }
  })
})

describe('курс: раздел обязателен, карточка, закрепление версий', () => {
  let courseId: string
  let enrollmentId: string
  const lessonIds: Record<string, string> = {}
  let pageId: string

  it('карточка курса по эталону; урок без раздела не создаётся', async () => {
    const c = await createCourse(author(), {
      title: `Курс s11-${stamp}`, language: 'uk', strictOrder: false, isCatalogVisible: true, tags: [],
      code: 'STD-01', durationDays: 4, workload: '2 години на тиждень', resultMode: 'final_test',
    })
    courseId = c.id
    courseIds.push(courseId)
    expect(c.code).toBe('STD-01')
    expect(c.resultMode).toBe('final_test')

    const noSection = await addLesson(author(), { moduleId: crypto.randomUUID(), title: 'Без розділу', itemType: 'resource', resource: { body: text('<p>x</p>') }, isRequired: true, videoThresholdPct: 90 })
    expect(noSection.ok).toBe(false)
    if (!noSection.ok) expect(noSection.code).toBe('section_required')
    const checks = await publishChecks(author(), courseId)
    expect(checks!.find(c => c.code === 'has_sections')!.ok).toBe(false)
  })

  it('элементы плана: подключить опубликованный ресурс каждого типа; черновик — нельзя', async () => {
    const mod = await addModule(author(), courseId, 'Видача замовлення')
    const page = await makeResource({ title: `Page s11-${stamp}`, body: text(`<p>${'слово '.repeat(360)}</p>`) }) // 360 слів → 120 с читання
    pageId = page.id
    const video = await makeResource({ title: `Video s11-${stamp}`, kind: 'video', mediaId: await media('video') })
    const file = await makeResource({ title: `File s11-${stamp}`, kind: 'file', mediaId: await media('file', 'ready', { pages: 3 }) })
    const link = await makeResource({ title: `Link s11-${stamp}`, kind: 'link', externalUrl: 'https://example.com/standard' })
    const draft = await makeResource({ title: `Draft s11-${stamp}`, body: text('<p>x</p>') })

    const notPublished = await addLesson(author(), { moduleId: mod!.id, title: 'Чернетка', itemType: 'resource', resourceId: draft.id, isRequired: true, videoThresholdPct: 90 })
    expect(notPublished.ok).toBe(false)
    if (!notPublished.ok) expect(notPublished.code).toBe('resource_not_published')

    for (const [key, r] of Object.entries({ page, video, file, link })) {
      expect((await publishResource(author(), r.id, { notifyAssigned: false })).ok).toBe(true)
      const l = await addLesson(author(), { moduleId: mod!.id, title: r.title, itemType: 'resource', resourceId: r.id, isRequired: true, videoThresholdPct: 90 })
      if (!l.ok) throw new Error(l.code)
      lessonIds[key] = l.lesson.id
    }
    const editor = await getCourseEditor(author(), courseId)
    expect(editor!.modules[0]!.lessons.map(l => l.resource?.kind)).toEqual(['article', 'video', 'file', 'link'])

    const pub = await publishCourse(author(), courseId, 'Перша версія')
    expect(pub.ok).toBe(true)
    // Уроки закреплены за снимками (Г-11.3)
    const [{ n }] = await admin<[{ n: number }]>`select count(*)::int as n from lessons l join modules m on m.id = l.module_id where m.course_version_id = ${(pub as { versionId: string }).versionId} and l.resource_version_id is not null`
    expect(n).toBe(4)
  })

  it('ученик доучивается на закреплённой версии, новая публикация ресурса его не трогает', async () => {
    const enr = await selfEnroll(learner(), courseId)
    if (!enr.ok) throw new Error(enr.code)
    enrollmentId = enr.enrollmentId

    await updateResource(author(), pageId, { body: text('<p>Зовсім інший текст.</p>') })
    await publishResource(author(), pageId, { notifyAssigned: false })
    const opened = await openLesson(learner(), enrollmentId, lessonIds.page!)
    expect(opened.ok).toBe(true)
    if (opened.ok) {
      expect(JSON.stringify(opened.lesson.body)).toContain('слово')
      expect(opened.lesson.resourceVersion).toBe(1)
      expect(opened.lesson.kind).toBe('article')
      expect(opened.lesson.requiredSeconds).toBe(120)
      expect(opened.lesson.section).toEqual({ title: 'Видача замовлення', number: 1 })
    }
  })

  it('страница: доскроллена + время чтения; сервер решает, не клиент', async () => {
    const t0 = await tickLesson(learner(), enrollmentId, lessonIds.page!, { seconds: 15, scrollPct: 60 })
    expect(t0!.ready).toBe(false)
    expect(t0!.reasons).toContain('Прочитай сторінку до кінця')
    expect(t0!.secondsSpent).toBe(0) // прошло меньше секунды с открытия — секунды не засчитаны

    await readThrough(admin, enrollmentId, lessonIds.page!, 119)
    const t1 = await tickLesson(learner(), enrollmentId, lessonIds.page!, { seconds: 0, scrollPct: 100 })
    expect(t1!.ready).toBe(false)
    expect(t1!.reasons).toEqual(['Ще 1 секунд'])
    await readThrough(admin, enrollmentId, lessonIds.page!, 120)
    expect((await tickLesson(learner(), enrollmentId, lessonIds.page!, { seconds: 0 }))!.ready).toBe(true)
    expect((await completeLesson(learner(), enrollmentId, lessonIds.page!)).ok).toBe(true)
  })

  it('видео: 85 % — нет, 91 % — зачёт (docs/11 §13.3)', async () => {
    await openLesson(learner(), enrollmentId, lessonIds.video!)
    const t = await tickLesson(learner(), enrollmentId, lessonIds.video!, { seconds: 0, videoPct: 85 })
    expect(t!.ready).toBe(false)
    expect(t!.reasons).toEqual(['Подивись відео до кінця'])
    expect((await completeLesson(learner(), enrollmentId, lessonIds.video!)).ok).toBe(false)
    // Проценты монотонны: откат до 50 не принимается
    expect((await tickLesson(learner(), enrollmentId, lessonIds.video!, { seconds: 0, videoPct: 50 }))!.videoPct).toBe(85)
    expect((await tickLesson(learner(), enrollmentId, lessonIds.video!, { seconds: 0, videoPct: 91 }))!.ready).toBe(true)
    expect((await completeLesson(learner(), enrollmentId, lessonIds.video!)).ok).toBe(true)
  })

  it('документ: 3 страницы → 45 с; пролистан или скачан', async () => {
    const opened = await openLesson(learner(), enrollmentId, lessonIds.file!)
    if (opened.ok) expect(opened.lesson.requiredSeconds).toBe(45)
    await backdateOpen(admin, enrollmentId, lessonIds.file!, 100)
    const t = await tickLesson(learner(), enrollmentId, lessonIds.file!, { seconds: 20, scrollPct: 40 })
    expect(t!.secondsSpent).toBe(20)
    expect(t!.reasons).toEqual(expect.arrayContaining(['Перегорни документ до кінця або завантаж його', 'Ще 25 секунд']))
    const d = await markDownloaded(learner(), enrollmentId, lessonIds.file!)
    expect(d!.reasons).toEqual(['Ще 25 секунд'])
    await readThrough(admin, enrollmentId, lessonIds.file!, 45)
    expect((await completeLesson(learner(), enrollmentId, lessonIds.file!)).ok).toBe(true)
  })

  it('ссылка: только после «Я ознайомився»', async () => {
    const opened = await openLesson(learner(), enrollmentId, lessonIds.link!)
    if (opened.ok) expect(opened.lesson.externalUrl).toBe('https://example.com/standard')
    const early = await completeLesson(learner(), enrollmentId, lessonIds.link!)
    expect(early.ok).toBe(false)
    if (!early.ok) expect(early.reasons).toEqual(['Підтверди: «Я ознайомився»'])
    const ack = await acknowledgeLesson(learner(), enrollmentId, lessonIds.link!)
    expect(ack!.ready).toBe(true)
    const done = await completeLesson(learner(), enrollmentId, lessonIds.link!)
    expect(done.ok && done.courseCompleted).toBe(true)
    expect((await enrollmentTree(learner(), enrollmentId))!.enrollment.status).toBe('done')
  })

  it('анти-накрутка: не больше 20 с за тик, не больше реального интервала, не чаще раза в 10 с', async () => {
    const c = await createCourse(author(), { title: `Анти s11-${stamp}`, language: 'uk', strictOrder: true, isCatalogVisible: true, tags: [] })
    courseIds.push(c.id)
    const mod = await addModule(author(), c.id, 'Розділ')
    const l = await addLesson(author(), { moduleId: mod!.id, title: 'Урок', itemType: 'resource', resource: { body: text('<p>x</p>') }, isRequired: true, videoThresholdPct: 90 })
    if (!l.ok) throw new Error(l.code)
    expect((await publishCourse(author(), c.id, 'v1')).ok).toBe(true)
    const enr = await selfEnroll(learner(), c.id)
    if (!enr.ok) throw new Error(enr.code)
    await openLesson(learner(), enr.enrollmentId, l.lesson.id)

    // Открыт 5 секунд назад: тик «60 секунд» даёт 5
    await backdateOpen(admin, enr.enrollmentId, l.lesson.id, 5)
    expect((await tickLesson(learner(), enr.enrollmentId, l.lesson.id, { seconds: 60 }))!.secondsSpent).toBe(5)
    // Сразу ещё тик — игнорируется
    expect((await tickLesson(learner(), enr.enrollmentId, l.lesson.id, { seconds: 20 }))!.secondsSpent).toBe(5)
    // Прошла минута: засчитывается не больше 20
    await admin`update lesson_progress set last_tick_at = now() - interval '60 seconds' where enrollment_id = ${enr.enrollmentId} and lesson_id = ${l.lesson.id}`
    expect((await tickLesson(learner(), enr.enrollmentId, l.lesson.id, { seconds: 60 }))!.secondsSpent).toBe(25)
    // Тик идемпотентен по фактам: scrollPct 100 затем 30 — остаётся 100
    await admin`update lesson_progress set last_tick_at = now() - interval '60 seconds' where enrollment_id = ${enr.enrollmentId} and lesson_id = ${l.lesson.id}`
    expect((await tickLesson(learner(), enr.enrollmentId, l.lesson.id, { seconds: 0, scrollPct: 100 }))!.scrollPct).toBe(100)
    expect((await tickLesson(learner(), enr.enrollmentId, l.lesson.id, { seconds: 0, scrollPct: 30 }))!.scrollPct).toBe(100)
  })

  it('правка урока в плане и публикация курса делают новый снимок ресурса', async () => {
    const editor = await getCourseEditor(author(), courseId) // черновик версии 2
    const pageLesson = editor!.modules[0]!.lessons[0]!
    await updateLesson(author(), pageLesson.id, { body: text('<p>Правка з плану курсу.</p>') })
    const before = (await getResource(author(), pageId))!.version
    const pub = await publishCourse(author(), courseId, 'Друга версія')
    expect(pub.ok).toBe(true)
    expect((await getResource(author(), pageId))!.version).toBe(before + 1)
    // Старая запись остаётся на версии 1 курса и старом снимке
    const opened = await openLesson(learner(), enrollmentId, lessonIds.page!)
    if (opened.ok) expect(opened.lesson.resourceVersion).toBe(1)
  })
})

describe('notifyAssigned — «Сповістити про оновлення» (docs/11 §14.2, docs/15 §14.6)', () => {
  let id: string

  it('без переключателя — только баннер; с переключателем — уведомление назначенным', async () => {
    const r = await makeResource({ title: `Стандарт s11-${stamp}`, body: text('<p>v1</p>') })
    id = r.id
    await publishResource(author(), id, { notifyAssigned: false })
    const a = await createAssignment(author(), {
      subjectType: 'resource', subjectId: id, lockVersion: false,
      audience: { rules: [{ type: 'user', ids: [learnerId] }], match: 'any' },
      dueMode: 'none', dueDays: 14, isMandatory: false, autoSync: false, tags: [], status: 'active',
      params: { contentType: 'resource' }, reminders: { notifyOnAssign: false },
    } as never)
    if (!a.ok) throw new Error(a.code)
    assignmentIds.push(a.assignmentId)
    await admin`delete from notifications where user_id = ${learnerId} and code = 'assignment_content_updated' and payload->>'assignmentId' = ${a.assignmentId}`

    await updateResource(author(), id, { body: text('<p>v2</p>') })
    const quiet = await publishResource(author(), id, { notifyAssigned: false })
    expect(quiet.ok && quiet.notified).toBe(0)
    expect((await listChanged(author())).items.some(i => i.id === a.assignmentId)).toBe(true)
    expect((await admin`select count(*)::int as n from notifications where user_id = ${learnerId} and code = 'assignment_content_updated' and payload->>'assignmentId' = ${a.assignmentId}`)[0]!.n).toBe(0)

    await updateResource(author(), id, { body: text('<p>v3</p>') })
    const loud = await publishResource(author(), id, { notifyAssigned: true, changelog: 'Оновили стандарт' })
    expect(loud.ok && loud.notified).toBe(1)
    expect((await admin`select count(*)::int as n from notifications where user_id = ${learnerId} and code = 'assignment_content_updated' and payload->>'assignmentId' = ${a.assignmentId}`)[0]!.n).toBe(1)
    expect((await listChanged(author())).items.some(i => i.id === a.assignmentId)).toBe(false) // баннер снят рассылкой
    const [audit] = await admin`select after from audit_log where action = 'resource.publish' and entity_id = ${id} order by created_at desc limit 1`
    expect((audit!.after as { notifyAssigned: boolean }).notifyAssigned).toBe(true)
  })

  it('публикация курса с notifyAssigned шлёт назначенным', async () => {
    const c = await createCourse(author(), { title: `Нотиф s11-${stamp}`, language: 'uk', strictOrder: true, isCatalogVisible: false, tags: [] })
    courseIds.push(c.id)
    const mod = await addModule(author(), c.id, 'Розділ')
    await addLesson(author(), { moduleId: mod!.id, title: 'Урок', itemType: 'resource', resource: { body: text('<p>x</p>') }, isRequired: true, videoThresholdPct: 90 })
    await publishCourse(author(), c.id, 'v1')
    const a = await createAssignment(author(), {
      subjectType: 'course', subjectId: c.id, lockVersion: false,
      audience: { rules: [{ type: 'user', ids: [learnerId] }], match: 'any' },
      dueMode: 'none', dueDays: 14, isMandatory: false, autoSync: false, tags: [], status: 'active',
      params: { contentType: 'course' }, reminders: { notifyOnAssign: false },
    } as never)
    if (!a.ok) throw new Error(a.code)
    assignmentIds.push(a.assignmentId)
    await admin`delete from notifications where user_id = ${learnerId} and code = 'assignment_content_updated' and payload->>'assignmentId' = ${a.assignmentId}`
    await getCourseEditor(author(), c.id)
    expect((await publishCourse(author(), c.id, 'v2 — оновили', true)).ok).toBe(true)
    expect((await admin`select count(*)::int as n from notifications where user_id = ${learnerId} and code = 'assignment_content_updated' and payload->>'assignmentId' = ${a.assignmentId}`)[0]!.n).toBe(1)
  })
})

describe('лимиты файлов (Г-11.4, docs/04)', () => {
  it('изображение ≤ 10, документ ≤ 50, аудио ≤ 100, видео ≤ 500 МБ; отказ до передачи с понятным текстом', () => {
    const mb = (n: number) => n * 1024 * 1024
    expect(MEDIA_LIMITS_MB).toEqual({ image: 10, file: 50, audio: 100, video: 500 })
    expect(checkFileLimits('image/png', mb(10)).ok).toBe(true)
    expect(checkFileLimits('image/png', mb(11))).toMatchObject({ ok: false, code: 'too_big', message: 'Файл завеликий. Максимум для зображення — 10 МБ' })
    expect(checkFileLimits('video/mp4', mb(600))).toMatchObject({ ok: false, code: 'too_big', message: 'Файл завеликий. Максимум для відео — 500 МБ' })
    expect(checkFileLimits('audio/mpeg', mb(100)).ok).toBe(true)
    expect(checkFileLimits('application/pdf', mb(51)).ok).toBe(false)
    expect(checkFileLimits('image/svg+xml', 1000).ok).toBe(true)
    expect(checkFileLimits('application/vnd.openxmlformats-officedocument.presentationml.presentation', 1000).ok).toBe(true)
    expect(checkFileLimits('application/x-msdownload', 10)).toMatchObject({ ok: false, code: 'mime_not_allowed', message: 'Формат не підтримується' })
    // На ресурс суммарно ≤ 1 ГБ
    expect(checkFileLimits('video/mp4', mb(400), mb(700))).toMatchObject({ ok: false, code: 'resource_too_big' })
    expect(checkFileLimits('video/mp4', mb(400), mb(600)).ok).toBe(true)
  })

  it('правила зачёта — чистая функция: время чтения и документа', () => {
    expect(readingSeconds('слово')).toBe(20)
    expect(readingSeconds('слово '.repeat(360))).toBe(120)
    expect(documentSeconds(null)).toBe(15)
    expect(documentSeconds(100)).toBe(600)
    const facts = { kind: 'article' as const, body: [], plainText: 'x', pages: null, minSeconds: 90, videoThresholdPct: 90 }
    const e = evaluateLesson(facts, { secondsSpent: 30, scrollPct: 100, videoPct: 0, acknowledged: false, downloaded: false, blocksState: {} })
    expect(e).toEqual({ ready: false, reasons: ['Ще 60 секунд'], requiredSeconds: 90 })
  })
})

describe('чужой тенант — 404 / пусто (CLAUDE.md п. 15)', () => {
  it('ресурсы, категории и группы другого тенанта не видны', async () => {
    const foreign = { tenantId: otherTenantId, actorId: authorId }
    expect(await getResource(foreign, resourceIds[0]!)).toBeNull()
    expect(await viewResource(foreign, resourceIds[0]!)).toBeNull()
    expect((await listResources(foreign, { status: 'all', q: `s11-${stamp}`, page: 1, perPage: 25 })).total).toBe(0)
    expect((await publishResource(foreign, resourceIds[0]!, { notifyAssigned: false })).ok).toBe(false)
    expect((await deleteResource(foreign, resourceIds[0]!)).ok).toBe(false)
    expect((await listResourceCategories(foreign)).some(c => categoryIds.includes(c.id))).toBe(false)
    expect((await listAccessGroups(foreign)).some(g => groupIds.includes(g.id))).toBe(false)
  })
})
