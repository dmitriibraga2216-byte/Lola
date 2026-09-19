import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const { createCourse, addModule, addLesson, updateLesson, publishChecks, publishCourse, getCourseEditor, slugify }
  = await import('../../server/services/courses')
const { selfEnroll, enrollmentTree, openLesson, tickLesson, completeLesson, myLearning, catalog }
  = await import('../../server/services/learning')
const { sanitizeUserHtml } = await import('../../server/services/sanitize')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string
let authorId: string
let learnerId: string
const created: string[] = []

beforeAll(async () => {
  const [t] = await admin`select id from tenants where slug = 'kappi'`
  tenantId = t!.id as string
  const [a] = await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`
  authorId = a!.id as string
  const [l] = await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000003'`
  learnerId = l!.id as string
})

afterAll(async () => {
  if (created.length) {
    await admin`delete from certificates where course_id in ${admin(created)}`
    await admin`delete from enrollments where subject_id in ${admin(created)}`
    await admin`delete from resources where id in (select l.item_id from lessons l join modules m on m.id = l.module_id join course_versions v on v.id = m.course_version_id where l.item_type = 'resource' and v.course_id in ${admin(created)})`
    await admin`delete from courses where id in ${admin(created)}`
  }
  await admin.end()
})

const suffix = Date.now()

const author = () => ({ tenantId, actorId: authorId })
const learner = () => ({ tenantId, actorId: learnerId })

const textBlock = (id: string, html = '<p>Текст уроку</p>') => ({ id, type: 'text' as const, html })

describe('санитизация HTML', () => {
  it('вырезает script и обработчики, оставляет allowlist', () => {
    const dirty = '<p onclick="x()">Привіт <script>alert(1)</script><b>жирний</b> <a href="javascript:evil()">лінк</a> <a href="https://ok">ok</a></p>'
    const clean = sanitizeUserHtml(dirty)
    expect(clean).not.toContain('<script')
    expect(clean).not.toContain('onclick')
    expect(clean).not.toContain('javascript:')
    expect(clean).toContain('<b>жирний</b>')
    expect(clean).toContain('rel="noopener noreferrer"')
  })

  it('slugify транслитерирует украинский', () => {
    expect(slugify('Гарячий цех: основи')).toBe('hariachyi-tsekh-osnovy')
  })
})

describe('курс: создание → публикация → прохождение', () => {
  let courseId: string
  const lessonIds: string[] = []
  let enrollmentId: string

  it('курс с 4 уроками создаётся, XSS в теле вырезается при сохранении', async () => {
    const course = await createCourse(author(), {
      title: `Тест-курс прохождения ${suffix}`,
      language: 'uk',
      strictOrder: true,
      isCatalogVisible: true,
      tags: [],
    })
    courseId = course.id
    created.push(courseId)

    const mod = await addModule(author(), courseId, 'Розділ 1')
    expect(mod).not.toBeNull()

    for (let i = 1; i <= 4; i++) {
      const lesson = await addLesson(author(), {
        moduleId: mod!.id,
        title: `Урок ${i}`,
        itemType: 'resource',
        resource: {
          body: [textBlock(`b${i}`, i === 2 ? '<p>Безпечно</p><script>alert("xss")</script>' : undefined)],
        },
        isRequired: i !== 4, // четвёртый — необязательный
        minSeconds: i === 3 ? 60 : null,
        videoThresholdPct: 90,
      })
      lessonIds.push(lesson!.id)
    }

    const editor = await getCourseEditor(author(), courseId)
    const secondBody = editor!.modules[0]!.lessons[1]!.body as { html: string }[]
    expect(JSON.stringify(secondBody)).not.toContain('<script')
    expect(secondBody[0]!.html).toContain('Безпечно')
  })

  it('публикация проходит проверки, версия 1 становится published', async () => {
    const checks = await publishChecks(author(), courseId)
    expect(checks!.every(c => c.ok)).toBe(true)

    const result = await publishCourse(author(), courseId, 'Перша версія курсу')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.version).toBe(1)
  })

  it('курс без уроков публиковать нельзя', async () => {
    const empty = await createCourse(author(), { title: `Порожній курс ${suffix}`, language: 'uk', strictOrder: true, isCatalogVisible: false, tags: [] })
    created.push(empty.id)
    const result = await publishCourse(author(), empty.id, 'спроба')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('not_publishable')
  })

  it('курс виден в каталоге, самозапись создаёт запись, повторная — 409', async () => {
    const list = await catalog(learner())
    expect(list.some(c => c.id === courseId)).toBe(true)

    const res = await selfEnroll(learner(), courseId)
    expect(res.ok).toBe(true)
    if (res.ok) enrollmentId = res.enrollmentId

    const again = await selfEnroll(learner(), courseId)
    expect(again.ok).toBe(false)
  })

  it('строгий порядок: третий урок заблокирован, пока не пройден первый и второй', async () => {
    const tree = await enrollmentTree(learner(), enrollmentId)
    expect(tree!.enrollment.requiredTotal).toBe(3)
    expect(tree!.modules[0]!.lessons.map(l => l.status)).toEqual(['available', 'locked', 'locked', 'locked'])
    expect(tree!.resumeLessonId).toBe(lessonIds[0])

    const locked = await openLesson(learner(), enrollmentId, lessonIds[2]!)
    expect(locked.ok).toBe(false)
    if (!locked.ok) expect(locked.code).toBe('locked')
  })

  it('открытие первого урока переводит запись в in_progress; завершение открывает второй', async () => {
    const opened = await openLesson(learner(), enrollmentId, lessonIds[0]!)
    expect(opened.ok).toBe(true)

    let tree = await enrollmentTree(learner(), enrollmentId)
    expect(tree!.enrollment.status).toBe('in_progress')

    const done = await completeLesson(learner(), enrollmentId, lessonIds[0]!)
    expect(done.ok).toBe(true)
    if (done.ok) expect(done.progressPct).toBe(33)

    tree = await enrollmentTree(learner(), enrollmentId)
    expect(tree!.modules[0]!.lessons[1]!.status).toBe('available')
    expect(tree!.resumeLessonId).toBe(lessonIds[1])
  })

  it('min_seconds: завершить нельзя, пока не прошло время; тики режутся до 20с', async () => {
    await openLesson(learner(), enrollmentId, lessonIds[1]!)
    await completeLesson(learner(), enrollmentId, lessonIds[1]!)

    const opened = await openLesson(learner(), enrollmentId, lessonIds[2]!)
    expect(opened.ok).toBe(true)

    const early = await completeLesson(learner(), enrollmentId, lessonIds[2]!)
    expect(early.ok).toBe(false)
    if (!early.ok) {
      expect(early.code).toBe('conditions_not_met')
      expect(early.reasons![0]).toMatch(/Ще 60 секунд/)
    }

    // Тик 60 секунд режется до 20; второй тик сразу — игнорируется
    const t1 = await tickLesson(learner(), enrollmentId, lessonIds[2]!, { seconds: 60 })
    expect(t1!.secondsSpent).toBe(20)
    const t2 = await tickLesson(learner(), enrollmentId, lessonIds[2]!, { seconds: 20 })
    expect(t2!.secondsSpent).toBe(20)

    // Накрутим через БД, как если бы прошли 3 нормальных тика
    await admin`update lesson_progress set seconds_spent = 60 where enrollment_id = ${enrollmentId} and lesson_id = ${lessonIds[2]!}`

    const done = await completeLesson(learner(), enrollmentId, lessonIds[2]!)
    expect(done.ok).toBe(true)
    if (done.ok) {
      expect(done.courseCompleted).toBe(true)
      expect(done.progressPct).toBe(100)
    }
  })

  it('курс completed при 3 обязательных из 4; необязательный остаётся доступен', async () => {
    const tree = await enrollmentTree(learner(), enrollmentId)
    expect(tree!.enrollment.status).toBe('completed')
    expect(tree!.modules[0]!.lessons[3]!.status).toBe('available')

    const done = await myLearning(learner(), 'done')
    expect(done.some(e => e.id === enrollmentId)).toBe(true)
  })

  it('правка урока после публикации создаёт версию 2, активная запись остаётся на версии 1', async () => {
    const editorBefore = await getCourseEditor(author(), courseId)
    expect(editorBefore!.version!.version).toBe(2) // ensureDraftVersion создал черновик
    expect(editorBefore!.version!.status).toBe('draft')

    const draftLesson = editorBefore!.modules[0]!.lessons[0]!
    await updateLesson(author(), draftLesson.id, { title: 'Урок 1 (оновлений)' })
    const pub = await publishCourse(author(), courseId, 'Оновили перший урок')
    expect(pub.ok).toBe(true)
    if (pub.ok) expect(pub.version).toBe(2)

    // Старая запись видит старую версию и старое название
    const tree = await enrollmentTree(learner(), enrollmentId)
    expect(tree!.version.version).toBe(1)
    expect(tree!.modules[0]!.lessons[0]!.title).toBe('Урок 1')

    // Одновременно опубликована ровно одна версия
    const [{ count }] = await admin<[{ count: number }]>`
      select count(*)::int as count from course_versions where course_id = ${courseId} and status = 'published'
    `
    expect(count).toBe(1)
  })
})
