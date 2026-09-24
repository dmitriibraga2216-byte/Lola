import postgres from 'postgres'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { offboardingStartSchema } from '../../shared/schemas/offboarding'
import { contentIssueQueueSchema, contentQualityQuerySchema } from '../../shared/schemas/contentIssues'

/**
 * PR-24 пакета `docs/v2` (`45-plan.md`): разбор жалобы — маршрутизация, резолюции, пересчёт
 * (`36-content-feedback.md` §4, §7.5, §7.8, §7.9, §9; патч П-12.4).
 *
 * Критерии приёмки `36` §13, закреплённые за этим PR:
 * - **4** — карточка `wrong_key` подтверждена `question_fixed`, администратор пересчитывает:
 *   попытки с улучшением получают новый балл и статус, с ухудшением — остаются как есть и
 *   перечислены отдельным списком, всё записано в `audit_log`;
 * - **5** — результат сменился с «ПРОВАЛЕНО» на «ВИКОНАНО»: человеку ушло `content_issue_rescored`
 *   со старым и новым баллом, прогресс назначения пересчитан, сертификат выдан;
 * - **6** — карточка в `fixed`, автор опубликовал новую версию материала: карточка закрыта
 *   автоматически, заявителям ушло `content_issue_fixed`;
 * - **8** — автор материала уволен (офбордингом PR-07): ответственным становится владелец
 *   категории, а не уволенный;
 * - **9** — в отчёте «Якість контенту» курс с 2 жалобами на 40 прохождений стоит выше курса
 *   с 15 жалобами на 3000.
 *
 * Плюс условие выхода плана: пересчёт по жалобе и пересчёт по тесту — **одна логика, две
 * точки входа** (проверяется тем, что предпросмотр, применение и «Перерахувати» теста дают
 * одни и те же числа), и изоляция: чужой тенант и чужая карточка — «не найдено».
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { submitReport } = await import('../../server/services/contentIssues')
const {
  updateIssue, getCard, listQueue, assignIssue, commentIssue, rescorePreview, rescoreIssue, setReporterMute,
} = await import('../../server/services/contentIssueTriage')
const { createRoutingRule, updateRoutingRule, deleteRoutingRule, listRoutingRules, reassignScan } = await import('../../server/services/contentIssueRouting')
const { contentQualityReport } = await import('../../server/services/contentQuality')
const { createResource, publishResource, updateResource } = await import('../../server/services/resources')
const { createCourse, addModule, addLesson, publishCourse } = await import('../../server/services/courses')
const { selfEnroll, openLesson } = await import('../../server/services/learning')
const { createBank, createQuestion, updateQuestion, createQuiz, setQuizQuestions } = await import('../../server/services/questions')
const { startAttempt, saveAnswer, submitAttempt, recalculateQuiz, planRecalc } = await import('../../server/services/attempts')
const { createCategory } = await import('../../server/services/categories')
const { startOffboarding, completeOffboarding } = await import('../../server/services/offboarding')
const { withTenant } = await import('../../server/utils/withTenant')
const { FRAME_KEYS } = await import('../../server/services/reportFrame')
const { attempts } = await import('../../server/db/schema')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const stamp = Date.now()
const TAG = `v224-${stamp}`
const FIRED_PHONE = `+38067${String(stamp).slice(-7)}`

let tenantId: string
let otherTenantId: string
let adminId: string
let authorId: string
let mentorId: string
let employeeId: string
let cashierId: string
let firedAuthorId: string

const resourceIds: string[] = []
const courseIds: string[] = []
const quizIds: string[] = []
const categoryIds: string[] = []
let bankId: string | null = null

const ctx = (actorId: string) => ({ tenantId, actorId })
const adminV = () => ({ tenantId, actorId: adminId, canTriage: true, isAdmin: true, canRescore: true, visibility: 'all' as const })
const authorV = () => ({ tenantId, actorId: authorId, canTriage: true, isAdmin: false, canRescore: false, visibility: 'own' as const })
const managerV = (locations: string[]) => ({ tenantId, actorId: mentorId, canTriage: false, isAdmin: false, canRescore: false, visibility: { locations } })
const text = (html: string) => [{ id: 'b1', type: 'text' as const, html }]
const opts = (...ids: string[]) => ids.map(id => ({ id, text: `Варіант ${id}` }))
const baseQ = { isCritical: false, difficulty: 3, points: 1, scoringMethod: 'formula' as const, attachFiles: false, negativeMarking: false, tags: [] as string[] }
const q = (query: Record<string, unknown>) => contentIssueQueueSchema.parse(query)

async function cleanupIssues() {
  await admin`delete from content_issue_events where tenant_id = ${tenantId}`
  await admin`delete from content_reports where tenant_id = ${tenantId}`
  await admin`update attempt_results set issue_id = null where tenant_id = ${tenantId} and issue_id is not null`
  await admin`delete from content_issues where tenant_id = ${tenantId}`
  await admin`delete from content_reporter_stats where tenant_id = ${tenantId}`
  await admin`delete from content_issue_routing_rules where tenant_id = ${tenantId}`
  await admin`delete from notifications where tenant_id = ${tenantId} and (code like 'content_issue%' or code like 'content_reporter%')`
}

async function cleanupFired() {
  for (const r of await admin`select id from users where tenant_id = ${tenantId} and phone = ${FIRED_PHONE}`) {
    const id = r.id as string
    await admin`delete from offboarding_cases where user_id = ${id}`
    await admin`delete from employee_lifecycle_state where user_id = ${id}`
    await admin`delete from sessions where user_id = ${id}`
    await admin`delete from user_placements where user_id = ${id}`
    await admin`delete from notifications where user_id = ${id}`
    await admin`delete from security_log where user_id = ${id}`
    await admin`delete from audit_log where entity_id = ${id}`
    await admin`delete from users where id = ${id}`
  }
}

/** Опубликованный материал с заданными авторами — цель жалобы. */
async function publishedResource(title: string, authorIds: string[]): Promise<string> {
  const r = await createResource(ctx(adminId), { kind: 'article', title: `${TAG} ${title}`, language: 'uk', tags: [], categoryIds: [], allowPrint: true, body: text('<p>Текст із помилкою</p>'), authorIds })
  resourceIds.push(r.id)
  const p = await publishResource(ctx(adminId), r.id, { notifyAssigned: false })
  if (!p.ok) throw new Error(`publishResource: ${p.code}`)
  return r.id
}

async function report(actorId: string, input: Parameters<typeof submitReport>[1]) {
  // Лимиты частоты — предмет PR-23 (§7.10); здесь они не проверяются и не мешают
  const r = await submitReport(ctx(actorId), input, { exemptFromLimits: true })
  if (!r.ok) throw new Error(`submitReport: ${JSON.stringify(r)}`)
  return r.result.issueId
}

async function issueRow(id: string) {
  return (await admin`select * from content_issues where id = ${id}`)[0]!
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  const [other] = await admin`
    insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції')
    on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = other!.id as string
  const pick = async (phone: string) => (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id as string
  adminId = await pick('+380661864742')
  authorId = await pick('+380670000001')
  mentorId = await pick('+380670000002')
  employeeId = await pick('+380670000003')
  cashierId = await pick('+380670000004')
  await cleanupIssues()
  await cleanupFired()
  const [fired] = await admin`
    insert into users (tenant_id, kind, full_name, phone, status)
    values (${tenantId}, 'employee', ${`${TAG} Автор, що звільняється`}, ${FIRED_PHONE}, 'active') returning id`
  firedAuthorId = fired!.id as string
})

afterAll(async () => {
  await cleanupIssues()
  if (quizIds.length) {
    await admin`delete from certificates where enrollment_id in (select id from enrollments where subject_id in ${admin(courseIds.length ? courseIds : ['00000000-0000-0000-0000-000000000000'])})`
    await admin`delete from attempts where quiz_id in ${admin(quizIds)}`
  }
  if (courseIds.length) {
    await admin`delete from task_status_log where user_id in (${employeeId}, ${cashierId}) and created_at >= to_timestamp(${stamp / 1000})`
    await admin`delete from enrollment_events where enrollment_id in (select id from enrollments where subject_id in ${admin(courseIds)})`
    await admin`delete from enrollments where subject_id in ${admin(courseIds)}`
    await admin`delete from courses where id in ${admin(courseIds)}`
  }
  if (quizIds.length) await admin`delete from quizzes where id in ${admin(quizIds)}`
  if (bankId) await admin`delete from question_banks where id = ${bankId}`
  if (resourceIds.length) await admin`delete from resources where id in ${admin(resourceIds)}`
  if (categoryIds.length) await admin`delete from course_categories where id in ${admin(categoryIds)}`
  await cleanupFired()
  await admin.end()
})

// ── Маршрутизация (§7.5) и критерий 8 ─────────────────────────────────────────────────────

describe('маршрутизация: правила, авторы, владелец категории, запасной путь (§7.5)', () => {
  let resourceId: string
  let firedResourceId: string
  let courseId: string
  let staleIssueId: string

  it('шаг (б): жалоба уходит действующему автору материала, в журнале — `assigned` от системы', async () => {
    resourceId = await publishedResource('Матеріал автора', [authorId])
    const id = await report(employeeId, { targetType: 'resource', targetId: resourceId, issueType: 'unclear', source: 'lesson', context: {} })
    const issue = await issueRow(id)
    expect(issue.assignee_id).toBe(authorId)
    expect(issue.status).toBe('new')
    const [ev] = await admin`select * from content_issue_events where issue_id = ${id} and kind = 'assigned'`
    expect(ev!.actor_id).toBeNull()
    expect((ev!.payload as { step: string }).step).toBe('author')
    const [n] = await admin`select * from notifications where ref_id = ${id} and code = 'content_issue_created'`
    expect(n!.user_id).toBe(authorId)
  })

  it('автор пожаловался на свой материал — карточка сразу «В роботі» на нём же (§12)', async () => {
    const id = await report(authorId, { targetType: 'resource', targetId: resourceId, issueType: 'outdated', source: 'lesson', comment: 'Застаріла інформація в третьому абзаці', context: {} })
    const issue = await issueRow(id)
    expect(issue.status).toBe('in_progress')
    expect(issue.assignee_id).toBe(authorId)
  })

  it('непустой набор правил без запасного правила не сохраняется (§6.3)', async () => {
    const r = await createRoutingRule(ctx(adminId), { sort: 10, targetType: null, issueType: 'typo', categoryId: null, assigneeUserId: adminId, assigneeRoleId: null, fallback: false, isActive: true })
    expect(r).toEqual({ ok: false, code: 'fallback_rule_required' })
  })

  it('шаг (а): правило по типу проблемы выигрывает у автора; запасное правило первым', async () => {
    const fb = await createRoutingRule(ctx(adminId), { sort: 100, targetType: 'quiz', issueType: 'tech', categoryId: null, assigneeUserId: mentorId, assigneeRoleId: null, fallback: true, isActive: true })
    expect(fb.ok).toBe(true)
    // У запасного правила фильтров нет: оно ловит то, что не поймали шаги а–в
    expect(fb.ok && fb.rule).toMatchObject({ fallback: true, targetType: null, issueType: null })
    const typo = await createRoutingRule(ctx(adminId), { sort: 10, targetType: null, issueType: 'typo', categoryId: null, assigneeUserId: adminId, assigneeRoleId: null, fallback: false, isActive: true })
    expect(typo.ok).toBe(true)

    const id = await report(employeeId, { targetType: 'resource', targetId: resourceId, issueType: 'typo', source: 'lesson', context: {} })
    const issue = await issueRow(id)
    expect(issue.assignee_id).toBe(adminId)
    const [ev] = await admin`select payload from content_issue_events where issue_id = ${id} and kind = 'assigned'`
    expect(ev!.payload).toMatchObject({ step: 'rule', rule_id: typo.ok ? typo.rule.id : null })

    // Выключить запасное правило или удалить его раньше остальных нельзя
    const rules = await listRoutingRules(ctx(adminId))
    const fallback = rules.find(r => r.fallback)!
    expect(await updateRoutingRule(ctx(adminId), fallback.id, { isActive: false })).toEqual({ ok: false, code: 'fallback_rule_required' })
    expect(await deleteRoutingRule(ctx(adminId), fallback.id)).toEqual({ ok: false, code: 'fallback_rule_required' })
  })

  it('критерий 8: автор уволен офбордингом PR-07 — ответственным становится владелец категории', async () => {
    const cat = await createCategory(ctx(adminId), { name: `${TAG} Кухня`, ownerId: mentorId })
    categoryIds.push(cat.id)
    const course = await createCourse(ctx(adminId), { title: `${TAG} Курс кухні`, categoryId: cat.id, language: 'uk', strictOrder: false, isCatalogVisible: false, tags: [] })
    courseId = course.id
    courseIds.push(course.id)
    firedResourceId = await publishedResource('Матеріал звільненого автора', [firedAuthorId])
    const mod = await addModule(ctx(adminId), course.id, 'Розділ')
    const lesson = await addLesson(ctx(adminId), { moduleId: mod!.id, title: `${TAG} Урок`, itemType: 'resource', resourceId: firedResourceId, isRequired: true, videoThresholdPct: 90 })
    expect(lesson.ok).toBe(true)

    // Пока автор работает, жалоба уходит ему — эту карточку потом разберёт reassign_scan
    staleIssueId = await report(employeeId, { targetType: 'resource', targetId: firedResourceId, issueType: 'unclear', source: 'lesson', context: {} })
    expect((await issueRow(staleIssueId)).assignee_id).toBe(firedAuthorId)

    // Увольнение — настоящим офбордингом, а не правкой статуса руками
    const today = new Date().toISOString().slice(0, 10)
    const started = await startOffboarding(ctx(adminId), offboardingStartSchema.parse({
      userId: firedAuthorId, reasonCode: 'own_wish', lastWorkingDay: today, courseIds: [], responsibleId: adminId,
    }))
    if (typeof started === 'string') throw new Error(`startOffboarding: ${started}`)
    const done = await completeOffboarding(ctx(adminId), started.id)
    expect(typeof done === 'string' ? done : done.state).toBe('done')
    const [person] = await admin`select status from users where id = ${firedAuthorId}`
    expect(person!.status).toBe('archived')

    const id = await report(employeeId, { targetType: 'resource', targetId: firedResourceId, issueType: 'broken_link', source: 'lesson', context: {} })
    const issue = await issueRow(id)
    expect(issue.assignee_id).toBe(mentorId)
    expect(issue.assignee_id).not.toBe(firedAuthorId)
    expect(issue.course_ids).toContain(courseId) // «Трек» — выведен через урок, заявитель пришёл без урока
    const [ev] = await admin`select payload from content_issue_events where issue_id = ${id} and kind = 'assigned'`
    expect((ev!.payload as { step: string }).step).toBe('category_owner')
  })

  it('правило, адресованное уволенному, пропускается — идём дальше по порядку', async () => {
    const rules = await listRoutingRules(ctx(adminId))
    const typo = rules.find(r => r.issueType === 'typo')!
    await updateRoutingRule(ctx(adminId), typo.id, { assigneeUserId: firedAuthorId })
    expect((await listRoutingRules(ctx(adminId))).find(r => r.id === typo.id)!.assigneeActive).toBe(false)
    const fresh = await publishedResource('Матеріал для правила', [authorId])
    const id = await report(mentorId, { targetType: 'resource', targetId: fresh, issueType: 'typo', source: 'lesson', context: {} })
    const issue = await issueRow(id)
    expect(issue.assignee_id).toBe(authorId)
    const [ev] = await admin`select payload from content_issue_events where issue_id = ${id} and kind = 'assigned'`
    expect((ev!.payload as { step: string }).step).toBe('author')
  })

  it('reassign_scan: открытые карточки уволенного ответственного уходят следующему', async () => {
    const moved = await reassignScan(tenantId)
    expect(moved).toBeGreaterThanOrEqual(1)
    expect((await issueRow(staleIssueId)).assignee_id).toBe(mentorId)
    const events = await admin`select payload from content_issue_events where issue_id = ${staleIssueId} and kind = 'assigned' order by created_at`
    expect(events.at(-1)!.payload).toMatchObject({ from: firedAuthorId, to: mentorId, step: 'category_owner' })
  })
})

// ── Переходы, видимость, изоляция (§2, §4, §12) ────────────────────────────────────────────

describe('разбор карточки: переходы статусов, резолюции, видимость (§2, §4)', () => {
  let resourceId: string
  let issueId: string

  it('«Взяти в роботу» — заявителям уходит `content_issue_accepted` (только колокольчик)', async () => {
    resourceId = await publishedResource('Матеріал для розбору', [authorId])
    issueId = await report(employeeId, { targetType: 'resource', targetId: resourceId, issueType: 'unclear', source: 'lesson', context: {} })
    const r = await updateIssue(authorV(), issueId, { status: 'in_progress' })
    expect(r.ok && r.card.status).toBe('in_progress')
    const [n] = await admin`select * from notifications where ref_id = ${issueId} and code = 'content_issue_accepted'`
    expect(n!.user_id).toBe(employeeId)
    expect(n!.channel).toBe('inapp')
  })

  it('«Виправлено» без резолюции и с резолюцией вопроса у материала — отказ с объяснением', async () => {
    const noRes = await updateIssue(authorV(), issueId, { status: 'fixed' })
    expect(!noRes.ok && noRes.code).toBe('resolution_required')
    const wrong = await updateIssue(authorV(), issueId, { status: 'fixed', resolution: 'question_fixed' })
    expect(!wrong.ok && wrong.code).toBe('resolution_invalid')
    // Отказ ничего не записал: карточка та же
    expect((await issueRow(issueId)).status).toBe('in_progress')
  })

  it('«Відкласти» — со сроком; отказ без комментария заявителю не проходит', async () => {
    const noDue = await updateIssue(authorV(), issueId, { status: 'deferred' })
    expect(!noDue.ok && noDue.code).toBe('due_required')
    const due = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)
    const deferred = await updateIssue(authorV(), issueId, { status: 'deferred', dueAt: due })
    expect(deferred.ok && deferred.card.status).toBe('deferred')
    const noComment = await updateIssue(authorV(), issueId, { status: 'rejected', resolution: 'not_an_error' })
    expect(!noComment.ok && noComment.code).toBe('comment_required')
  })

  it('второй из двух одновременных разборов получает 409 и актуальную карточку (§12)', async () => {
    const back = await updateIssue(authorV(), issueId, { status: 'in_progress' })
    expect(back.ok).toBe(true)
    const first = await updateIssue(authorV(), issueId, { status: 'fixed', resolution: 'fixed' })
    expect(first.ok).toBe(true)
    const second = await updateIssue(adminV(), issueId, { status: 'fixed', resolution: 'fixed' })
    expect(!second.ok && second.code).toBe('invalid_transition')
    expect(!second.ok && second.card?.status).toBe('fixed')
  })

  it('автор видит только свой контент; керівник — только карточки со своих точек; чужой тенант — 404', async () => {
    const foreignRes = await publishedResource('Чужий для автора матеріал', [adminId])
    const foreignIssue = await report(employeeId, { targetType: 'resource', targetId: foreignRes, issueType: 'unclear', source: 'lesson', context: {} })
    // Карточку маршрутизация отдала администратору (автор материала) — методисту она не видна
    expect(await getCard(authorV(), foreignIssue)).toBeNull()
    expect(await getCard(authorV(), issueId)).not.toBeNull()
    expect((await listQueue(authorV(), q({ tab: 'all' }))).items.some(i => i.id === foreignIssue)).toBe(false)

    const [pl] = await admin`select location_id from user_placements where user_id = ${employeeId} and ended_at is null limit 1`
    const mine = await getCard(managerV([pl!.location_id as string]), foreignIssue)
    expect(mine).not.toBeNull()
    // Керівник точки видит карточку без кнопок разбора и без внутренних заметок (§5.4)
    expect(mine!.actions).toEqual(['comment'])
    expect(await getCard(managerV(['00000000-0000-4000-8000-000000000000']), foreignIssue)).toBeNull()

    expect(await getCard({ ...adminV(), tenantId: otherTenantId }, issueId)).toBeNull()
  })

  it('внутренняя заметка видна тем, кто разбирает, и не видна керівнику', async () => {
    await commentIssue(adminV(), issueId, { comment: 'Перевірив на трьох точках', isInternal: true })
    const [pl] = await admin`select location_id from user_placements where user_id = ${employeeId} and ended_at is null limit 1`
    const forAdmin = await getCard(adminV(), issueId)
    const forManager = await getCard(managerV([pl!.location_id as string]), issueId)
    expect(forAdmin!.events.some(e => e.isInternal && e.comment === 'Перевірив на трьох точках')).toBe(true)
    expect(forManager!.events.some(e => e.isInternal)).toBe(false)
  })

  it('переназначить можно только на того, кто вправе разбирать', async () => {
    const bad = await assignIssue(adminV(), issueId, cashierId)
    expect(!bad.ok && bad.code).toBe('assignee_invalid')
    const ok = await assignIssue(adminV(), issueId, adminId)
    expect(ok.ok && ok.card.assignee?.id).toBe(adminId)
  })

  it('очередь: сортировка по числу жалоб, фильтр «Тип», вкладки', async () => {
    const all = await listQueue(adminV(), q({ tab: 'all', limit: 100 }))
    const counts = all.items.map(i => i.reportsCount)
    expect(counts).toEqual([...counts].sort((a, b) => b - a))
    const typo = await listQueue(adminV(), q({ tab: 'all', issueType: 'typo', limit: 100 }))
    expect(typo.items.length).toBeGreaterThan(0)
    expect(typo.items.every(i => i.issueType === 'typo')).toBe(true)
    const fixed = await listQueue(adminV(), q({ tab: 'fixed', limit: 100 }))
    expect(fixed.items.some(i => i.id === issueId)).toBe(true)
  })

  it('очередь листается ключевым курсором: страницы не пересекаются и вместе дают весь список', async () => {
    const all = await listQueue(adminV(), q({ tab: 'all', limit: 100 }))
    expect(all.total).toBeGreaterThan(3)
    expect(all.nextCursor).toBeNull()
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 20; guard++) {
      // Страница в 3 строки — мимо схемы (там 10/25/50/100): проверяется механика курсора, а не размер
      const pageOf = await listQueue(adminV(), { ...q({ tab: 'all', ...(cursor ? { cursor } : {}) }), limit: 3 })
      expect(pageOf.total).toBe(all.total)
      seen.push(...pageOf.items.map(i => i.id))
      if (!pageOf.nextCursor) break
      cursor = pageOf.nextCursor
    }
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toEqual(all.items.map(i => i.id))
    // Битый курсор — 400 на входе, а не первая страница по кругу
    expect(contentIssueQueueSchema.safeParse({ tab: 'all', cursor: 'не-курсор' }).success).toBe(false)
  })

  it('три `spam` подряд — `muted_until` +14 дней, человеку ушло `content_reporter_muted` (§7.11)', async () => {
    const targets = [await publishedResource('Спам 1', [authorId]), await publishedResource('Спам 2', [authorId]), await publishedResource('Спам 3', [authorId])]
    for (const t of targets) {
      const id = await report(cashierId, { targetType: 'resource', targetId: t, issueType: 'typo', source: 'lesson', context: {} })
      const r = await updateIssue(adminV(), id, { status: 'rejected', resolution: 'spam', resolutionComment: 'Помилки в тексті немає' })
      expect(r.ok).toBe(true)
    }
    const [st] = await admin`select * from content_reporter_stats where tenant_id = ${tenantId} and user_id = ${cashierId}`
    expect(st!.consecutive_spam).toBe(3)
    const days = (new Date(st!.muted_until as string).getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(13)
    const [n] = await admin`select * from notifications where user_id = ${cashierId} and code = 'content_reporter_muted'`
    expect(n).toBeDefined()
    const [rej] = await admin`select payload from notifications where user_id = ${cashierId} and code = 'content_issue_rejected' limit 1`
    expect((rej!.payload as { comment: string }).comment).toBe('Помилки в тексті немає')
    // Снимает mute администратор — и серия обнуляется
    expect((await setReporterMute(adminV(), cashierId, null)).ok).toBe(true)
    const [after] = await admin`select muted_until, consecutive_spam from content_reporter_stats where tenant_id = ${tenantId} and user_id = ${cashierId}`
    expect(after).toMatchObject({ muted_until: null, consecutive_spam: 0 })
  })
})

// ── Критерий 6: закрытие по публикации новой версии ─────────────────────────────────────

describe('критерий 6: карточка в `fixed` закрывается публикацией новой версии материала', () => {
  it('правка в черновике не закрывает; публикация закрывает и отвечает заявителям', async () => {
    const resourceId = await publishedResource('Матеріал до виправлення', [authorId])
    const issueId = await report(employeeId, { targetType: 'resource', targetId: resourceId, issueType: 'typo', source: 'lesson', context: {} })
    expect((await issueRow(issueId)).content_version).toBe(1)
    expect((await updateIssue(authorV(), issueId, { status: 'in_progress' })).ok).toBe(true)
    const fixed = await updateIssue(authorV(), issueId, { status: 'fixed', resolution: 'fixed', resolutionComment: 'Виправили друкарську помилку' })
    // Версии выше жалобы ещё нет — карточка ждёт публикации (§7.9)
    expect(fixed.ok && fixed.card.status).toBe('fixed')

    await updateResource(ctx(authorId), resourceId, { body: text('<p>Текст без помилки</p>') })
    expect((await issueRow(issueId)).status).toBe('fixed')

    const pub = await publishResource(ctx(authorId), resourceId, { notifyAssigned: false })
    expect(pub.ok && pub.version).toBe(2)
    const issue = await issueRow(issueId)
    expect(issue.status).toBe('closed')
    expect(issue.closed_at).not.toBeNull()
    const [ev] = await admin`select * from content_issue_events where issue_id = ${issueId} and to_status = 'closed'`
    expect(ev!.payload).toMatchObject({ by: 'publication' })
    const notes = await admin`select user_id, channel from notifications where ref_id = ${issueId} and code = 'content_issue_fixed'`
    expect(notes.map(n => n.user_id)).toEqual([employeeId])
    const [rep] = await admin`select notified_at from content_reports where issue_id = ${issueId}`
    expect(rep!.notified_at).not.toBeNull()
  })

  it('исправление, опубликованное раньше отметки «Виправлено», закрывает карточку сразу', async () => {
    const resourceId = await publishedResource('Вже виправлений матеріал', [authorId])
    const issueId = await report(employeeId, { targetType: 'resource', targetId: resourceId, issueType: 'outdated', comment: 'Ціни в меню змінилися', source: 'lesson', context: {} })
    await updateIssue(authorV(), issueId, { status: 'in_progress' })
    await updateResource(ctx(authorId), resourceId, { body: text('<p>Нові ціни</p>') })
    await publishResource(ctx(authorId), resourceId, { notifyAssigned: false })
    expect((await issueRow(issueId)).status).toBe('in_progress')
    const r = await updateIssue(authorV(), issueId, { status: 'fixed', resolution: 'fixed' })
    expect(r.ok && r.card.status).toBe('closed')
  })
})

// ── Критерии 4 и 5: пересчёт из карточки — вторая точка входа в «Перерахувати» ───────────

describe('критерии 4 и 5: пересчёт результатов по жалобе (§7.8, П-12.4)', () => {
  let quizId: string
  let qKey: string
  let q2: string
  let issueId: string
  let failedAttempt: string
  let passedAttempt: string
  let failedEnrollment: string

  async function takeQuiz(userId: string, courseId: string, lessonId: string, keyAnswer: string, reportDuring = false) {
    const enr = await selfEnroll(ctx(userId), courseId)
    if (!enr.ok) throw new Error(`selfEnroll: ${enr.code}`)
    await openLesson(ctx(userId), enr.enrollmentId, lessonId)
    const a = await startAttempt(ctx(userId), quizId, { enrollmentId: enr.enrollmentId, lessonId })
    if (!a.ok) throw new Error(`startAttempt: ${a.code}`)
    await saveAnswer(ctx(userId), a.attemptId, qKey, { optionId: keyAnswer })
    await saveAnswer(ctx(userId), a.attemptId, q2, { optionId: 'a' })
    if (reportDuring) {
      // Жалоба во время попытки (PR-23): попытку не блокирует, баллы помечены к пересчёту
      issueId = await report(userId, {
        targetType: 'question', targetId: qKey, issueType: 'wrong_key', comment: 'Правильна відповідь — b, а не a',
        source: 'attempt', attemptId: a.attemptId, lessonId, enrollmentId: enr.enrollmentId, context: {},
      })
    }
    const s = await submitAttempt(ctx(userId), a.attemptId)
    if (!s.ok) throw new Error(`submitAttempt: ${s.code}`)
    return { attemptId: a.attemptId, enrollmentId: enr.enrollmentId, status: s.status }
  }

  it('готовим тест с неверным ключом: у одного «ПРОВАЛЕНО», у другого «ВИКОНАНО»', async () => {
    bankId = (await createBank(ctx(adminId), { name: `${TAG} банк` })).id
    qKey = (await createQuestion(ctx(adminId), { bankId, kind: 'single', stem: text('<p>Температура зберігання</p>'), options: opts('a', 'b', 'c'), answer: { correctId: 'a' }, ...baseQ })).id
    q2 = (await createQuestion(ctx(adminId), { bankId, kind: 'single', stem: text('<p>Друге питання</p>'), options: opts('a', 'b'), answer: { correctId: 'a' }, ...baseQ })).id
    quizId = (await createQuiz(ctx(adminId), { title: `${TAG} Тест`, kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })).id
    quizIds.push(quizId)
    await setQuizQuestions(ctx(adminId), quizId, [{ questionId: qKey, sort: 0 }, { questionId: q2, sort: 1 }])
    const course = await createCourse(ctx(adminId), { title: `${TAG} Курс з тестом`, language: 'uk', strictOrder: false, isCatalogVisible: true, tags: [], validityMonths: 12 })
    courseIds.push(course.id)
    const mod = await addModule(ctx(adminId), course.id, 'Розділ')
    const lesson = await addLesson(ctx(adminId), { moduleId: mod!.id, title: 'Тест', itemType: 'quiz', quizId, isRequired: true, videoThresholdPct: 90, passScorePct: 100 })
    if (!lesson.ok) throw new Error('lesson')
    expect((await publishCourse(ctx(adminId), course.id, 'v1')).ok).toBe(true)

    // Сотрудник ответил верно по сути («b»), но ключ считает иначе — 50 %, провал
    const failed = await takeQuiz(employeeId, course.id, lesson.lesson.id, 'b', true)
    expect(failed.status).toBe('failed')
    failedAttempt = failed.attemptId
    failedEnrollment = failed.enrollmentId
    // Кассир угадал неверный ключ — 100 %, зачёт; при исправлении ключа он бы упал
    const passed = await takeQuiz(cashierId, course.id, lesson.lesson.id, 'a')
    expect(passed.status).toBe('passed')
    passedAttempt = passed.attemptId

    const issue = await issueRow(issueId)
    expect(issue).toMatchObject({ affects_scoring: true, rescore_state: 'needed', content_version: 1 })
  })

  it('ключ исправлен, жалоба подтверждена `question_fixed` — администратору ушло «можна перерахувати»', async () => {
    const upd = await updateQuestion(ctx(adminId), qKey, { answer: { correctId: 'b' } })
    expect(upd!.version).toBe(2)
    expect((await updateIssue(adminV(), issueId, { status: 'in_progress' })).ok).toBe(true)
    const fixed = await updateIssue(adminV(), issueId, { status: 'fixed', resolution: 'question_fixed', resolutionComment: 'Ключ виправлено' })
    expect(fixed.ok).toBe(true)
    // Баллы ждут пересчёта — карточка не закрылась, хотя версия вопроса уже выше
    expect(fixed.ok && fixed.card.status).toBe('fixed')
    expect(fixed.ok && fixed.card.actions).toContain('rescore')
    expect(fixed.ok && fixed.card.impact).toEqual({ attemptsTotal: 2, failedOnQuestion: 1 })
    const [n] = await admin`select * from notifications where ref_id = ${issueId} and code = 'content_issue_rescore_ready' and user_id = ${adminId}`
    expect(n!.channel).toBe('email')
    expect((n!.payload as { count: number }).count).toBe(2)
    // Автор правит вопрос, но пересчитывать результаты людей не вправе (§2)
    expect(await getCard(authorV(), issueId).then(c => c?.actions.includes('rescore') ?? false)).toBe(false)
  })

  it('предпросмотр: изменится 1 попытка из 2, одна станет «ВИКОНАНО», падение не применится', async () => {
    const r = await rescorePreview(adminV(), issueId)
    expect(r.ok && r.preview).toEqual({ mode: 'recalc', attemptsTotal: 2, attemptsChanged: 1, toPassed: 1, toFailedSkipped: 1, worseSkipped: 1, avgDelta: 50 })
  })

  it('критерий 4: улучшение применено, ухудшение осталось как есть и перечислено отдельно, всё в audit_log', async () => {
    const [snapBefore] = await admin`select snapshot from attempts where id = ${failedAttempt}`
    const r = await rescoreIssue(adminV(), issueId, { reason: 'Ключ питання виправлено за скаргою' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result).toMatchObject({ mode: 'recalc', attemptsTotal: 2, rescoredAttempts: 1, toPassed: 1 })
    expect(r.result.worse).toHaveLength(1)
    expect(r.result.worse[0]).toMatchObject({ attemptId: passedAttempt, userId: cashierId, scoreBefore: 100, scoreAfter: 50, passedBefore: true, passedAfter: false })
    expect(r.result.worse[0]!.fullName.length).toBeGreaterThan(0)

    const [improved] = await admin`select status, score, passed, snapshot from attempts where id = ${failedAttempt}`
    expect(improved).toMatchObject({ status: 'passed', passed: true })
    expect(Number(improved!.score)).toBe(100)
    expect(improved!.snapshot).toEqual(snapBefore!.snapshot) // снапшот не переписывается никогда (правило 4)
    const results = await admin`select reason, issue_id, comment from attempt_results where attempt_id = ${failedAttempt} order by created_at`
    expect(results.map(x => x.reason)).toEqual(['submit', 'recalculate'])
    expect(results[1]).toMatchObject({ issue_id: issueId, comment: 'Ключ питання виправлено за скаргою' })

    const [untouched] = await admin`select status, score from attempts where id = ${passedAttempt}`
    expect(untouched!.status).toBe('passed')
    expect(Number(untouched!.score)).toBe(100)
    expect((await admin`select count(*)::int as n from attempt_results where attempt_id = ${passedAttempt} and reason = 'recalculate'`)[0]!.n).toBe(0)

    const [audit] = await admin`select after from audit_log where action = 'content_issue.rescore' and entity_id = ${issueId}`
    expect(audit!.after).toMatchObject({ issueId, reason: 'Ключ питання виправлено за скаргою', rescored_attempts: 1, worse_attempt_ids: [passedAttempt] })
    const [perAttempt] = await admin`select after from audit_log where action = 'attempt.recalculate' and entity_id = ${failedAttempt}`
    expect(perAttempt!.after).toMatchObject({ issueId })
  })

  it('критерий 5: человеку ушло `content_issue_rescored` со старым и новым баллом, курс завершён, сертификат выдан', async () => {
    const [n] = await admin`select payload from notifications where code = 'content_issue_rescored' and user_id = ${employeeId} and ref_id = ${issueId}`
    expect(n!.payload).toMatchObject({ scoreOld: '50%', scoreNew: '100%' })
    expect((n!.payload as { title: string }).title.length).toBeGreaterThan(0)
    const [enr] = await admin`select status, progress_pct from enrollments where id = ${failedEnrollment}`
    expect(enr!.status).toBe('done')
    expect(Number(enr!.progress_pct)).toBe(100)
    const [cert] = await admin`select number, revoked_at from certificates where enrollment_id = ${failedEnrollment}`
    expect(cert!.number).toMatch(/^LO-\d{4}-\d{6}$/)
    expect(cert!.revoked_at).toBeNull()
    // Кассиру, у которого результат не изменился, ничего не пришло
    expect((await admin`select count(*)::int as n from notifications where code = 'content_issue_rescored' and user_id = ${cashierId}`)[0]!.n).toBe(0)
  })

  it('после пересчёта карточка закрылась сама: версия вопроса выше жалобы, баллы пересчитаны (§7.9)', async () => {
    const issue = await issueRow(issueId)
    expect(issue).toMatchObject({ status: 'closed', rescore_state: 'done', rescored_attempts: 1 })
    const [n] = await admin`select user_id from notifications where ref_id = ${issueId} and code = 'content_issue_fixed'`
    expect(n!.user_id).toBe(employeeId)
    // Повторный пересчёт по той же карточке запрещён — нужна новая карточка
    const again = await rescoreIssue(adminV(), issueId, { reason: 'Ще раз, на всяк випадок' })
    expect(!again.ok && again.code).toBe('already_rescored')
  })

  it('одна логика, две точки входа: «Перерахувати» теста считает то же, но применяет по правилу D-013', async () => {
    const r = await recalculateQuiz(ctx(adminId), quizId, 'Перерахунок тесту')
    expect(r).toMatchObject({ total: 2 })
    // Тот же балл, что пересчёт по жалобе показал в списке «с ухудшением»: считала одна функция
    const [after] = await admin`select status, score from attempts where id = ${passedAttempt}`
    expect(after!.status).toBe('failed')
    expect(Number(after!.score)).toBe(50)
    const [last] = await admin`select issue_id from attempt_results where attempt_id = ${passedAttempt} order by created_at desc limit 1`
    expect(last!.issue_id).toBeNull()
  })

  it('`question_void`: вопрос исключается из знаменателя — тот же подсчёт без записи', async () => {
    const plan = await withTenant(tenantId, adminId, async (tx) => {
      const [row] = await tx.select().from(attempts).where(eq(attempts.id, passedAttempt))
      return planRecalc(tx, row!, { rekeyQuestionIds: [], voidQuestionIds: [qKey], policy: 'improve_only' })
    })
    // Без вопроса с ключом остаётся одно верное из одного — 100 %
    expect(plan.after.score).toBe(100)
    expect(plan.after.maxScore).toBe(1)
    expect(plan.verdict).toBe('improved')
  })
})

// ── Критерий 9: «Якість контенту» ───────────────────────────────────────────────────────

describe('критерий 9: отчёт «Якість контенту» нормирует жалобы на 100 прохождений', () => {
  let courseA: string
  let courseB: string

  async function courseWithPasses(title: string, passes: number) {
    const [c] = await admin`
      insert into courses (tenant_id, title, slug, status, created_by)
      values (${tenantId}, ${`${TAG} ${title}`}, ${`${TAG}-${title}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')}, 'published', ${adminId}) returning id`
    const [v] = await admin`insert into course_versions (tenant_id, course_id, version, status) values (${tenantId}, ${c!.id}, 1, 'published') returning id`
    courseIds.push(c!.id as string)
    // Прохождение — начатая запись на курс; одна и та же запись человека может повторяться
    await admin`
      insert into enrollments (tenant_id, user_id, subject_id, version_id, status, started_at, source)
      select ${tenantId}, ${employeeId}, ${c!.id}, ${v!.id}, 'in_progress', now(), 'self' from generate_series(1, ${passes})`
    return c!.id as string
  }

  async function complaints(courseId: string, issues: number, reporters: string[]) {
    for (let k = 0; k < issues; k++) {
      const [i] = await admin`
        insert into content_issues (tenant_id, target_type, target_id, issue_type, title, dedupe_key, course_ids)
        values (${tenantId}, 'lesson', gen_random_uuid(), 'unclear', ${`${TAG} урок ${k}`}, ${`${TAG}:${courseId}:${k}`}, array[${courseId}]::uuid[])
        returning id`
      for (const userId of reporters) {
        await admin`insert into content_reports (tenant_id, issue_id, user_id, source) values (${tenantId}, ${i!.id}, ${userId}, 'lesson')`
      }
    }
  }

  it('курс с 2 жалобами на 40 прохождений выше курса с 15 жалобами на 3000', async () => {
    courseA = await courseWithPasses('Малий курс', 40)
    courseB = await courseWithPasses('Великий курс', 3000)
    await complaints(courseA, 1, [employeeId, mentorId])
    await complaints(courseB, 3, [adminId, authorId, mentorId, employeeId, cashierId])

    const report = await contentQualityReport({ tenantId, actorId: adminId, scope: null }, contentQualityQuerySchema.parse({ groupBy: 'course' }))
    const a = report.rows.findIndex(r => r.targetId === courseA)
    const b = report.rows.findIndex(r => r.targetId === courseB)
    expect(report.rows[a]).toMatchObject({ complaints: 2, passes: 40, per100: 5 })
    expect(report.rows[b]).toMatchObject({ complaints: 15, passes: 3000, per100: 0.5 })
    expect(a).toBeLessThan(b)
  })

  it('детализация строки — заявители единым каркасом колонок (docs/22 §13.3)', async () => {
    const report = await contentQualityReport({ tenantId, actorId: adminId, scope: null }, contentQualityQuerySchema.parse({ groupBy: 'course', drillKey: `course:${courseA}` }))
    expect(report.people).toHaveLength(2)
    for (const key of FRAME_KEYS) expect(report.people![0]).toHaveProperty(key)
  })

  it('область видимости керівника сужает и числитель, и знаменатель', async () => {
    const report = await contentQualityReport({ tenantId, actorId: mentorId, scope: ['00000000-0000-4000-8000-000000000000'] }, contentQualityQuerySchema.parse({ groupBy: 'course' }))
    expect(report.rows.find(r => r.targetId === courseA)).toBeUndefined()
  })
})
