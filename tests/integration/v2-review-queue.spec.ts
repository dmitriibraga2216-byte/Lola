import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REVIEW_QUEUE_STATUSES, REVIEW_TASK_TYPES } from '../../shared/enums'

/**
 * PR-18 пакета `docs/v2` (`45-plan.md`): `review_queue_items` как таблица — источник истины
 * о состоянии очереди проверки (`14` §3.3, `docs/v2/37-review-delegation.md`, решения
 * `44` В-2 и В-15, патч П-13).
 *
 * Критерии приёмки `37` §13, закреплённые за этим PR:
 * - **5** — работа, которую сдал сам наставник, не появляется ни в одном его табе;
 * - **6** — наставник-автор материала видит жёлтую плашку, решение ему **разрешено**,
 *   а факт попадает в `audit_log` (основание отчёта `37` §9.2).
 *
 * Плюс условия выхода PR-18:
 * - очередь **поддерживается, а не пересобирается**: закрытие — это `status = 'done'`,
 *   строка остаётся; повторная сдача открывает ту же строку, второй не появляется;
 * - ответ `/review/queue` несёт `total` и курсор;
 * - `subject_kind` снимается из `users.kind` один раз, при постановке, и не пересчитывается.
 */

const { enqueueReview, closeReview, listReviewQueue, reviewConflict } = await import('../../server/services/reviewQueue')
const { createWorkshop, submitWorkshop, claim, grade, release, submissionForReview } = await import('../../server/services/workshops')
const { createBank, createQuestion, createQuiz, setQuizQuestions } = await import('../../server/services/questions')
const { startAttempt, saveAnswer, submitAttempt, gradeManual, annulAttempt } = await import('../../server/services/attempts')
const { withTenant } = await import('../../server/utils/withTenant')
const { assignWithParams } = await import('./_assign')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

let tenantId: string
let otherTenantId: string
let adminId: string
let mentorId: string
let learnerId: string
const workshopIds: string[] = []
const quizIds: string[] = []
const assignmentIds: string[] = []
const syntheticIds: string[] = []

const author = () => ({ tenantId, actorId: adminId })
const mentor = () => ({ tenantId, actorId: mentorId })
const learner = () => ({ tenantId, actorId: learnerId })
const stem = (text: string) => [{ id: 'b1', type: 'text' as const, html: `<p>${text}</p>` }]

/** Строки очереди по источнику — читаются ролью владельца БД, мимо RLS: проверяем факт, а не вид. */
async function queueRows(taskType: string, sourceId: string) {
  return admin`select * from review_queue_items where task_type = ${taskType} and source_id = ${sourceId}`
}

beforeAll(async () => {
  const [t] = await admin`select id from tenants where slug = 'kappi'`
  tenantId = t!.id as string
  const [other] = await admin`
    insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції')
    on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = other!.id as string
  const pick = async (phone: string) => (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id as string
  adminId = await pick('+380661864742')
  mentorId = await pick('+380670000002')
  learnerId = await pick('+380670000003')
})

afterAll(async () => {
  if (syntheticIds.length) await admin`delete from review_queue_items where id in ${admin(syntheticIds)}`
  if (workshopIds.length) {
    await admin`delete from review_queue_items where task_type = 'workshop' and source_id in (select id from workshop_submissions where workshop_id in ${admin(workshopIds)})`
    await admin`delete from workshop_comments where submission_id in (select id from workshop_submissions where workshop_id in ${admin(workshopIds)})`
    await admin`delete from workshop_submissions where workshop_id in ${admin(workshopIds)}`
    await admin`delete from workshops where id in ${admin(workshopIds)}`
  }
  if (quizIds.length) {
    await admin`delete from review_queue_items where task_type = 'quiz_open_answer' and source_id in (select aa.id from attempt_answers aa join attempts a on a.id = aa.attempt_id where a.quiz_id in ${admin(quizIds)})`
    await admin`delete from attempts where quiz_id in ${admin(quizIds)}`
    await admin`delete from quizzes where id in ${admin(quizIds)}`
  }
  if (assignmentIds.length) await admin`delete from assignments where id in ${admin(assignmentIds)}`
  await admin`delete from question_banks where tenant_id = ${tenantId} and name like 'PR18-банк %'`
  await admin.end()
})

// ── Миграция 0066 ───────────────────────────────────────────────────────────────────────────

describe('миграция 0066: review_queue_items', () => {
  it('RLS включён и принудителен, политика tenant_isolation имеет using и with check', async () => {
    const [row] = await admin`
      select c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
             p.polqual is not null as has_using, p.polwithcheck is not null as has_check
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_policy p on p.polrelid = c.oid and p.polname = 'tenant_isolation'
       where n.nspname = 'public' and c.relname = 'review_queue_items'`
    expect(row, 'таблицы review_queue_items нет').toBeDefined()
    expect(row!.enabled).toBe(true)
    expect(row!.forced).toBe(true)
    expect(row!.has_using).toBe(true)
    expect(row!.has_check).toBe(true)
  })

  it('есть непартиальный индекс, начинающийся с tenant_id, и FK на tenants', async () => {
    const [idx] = await admin`
      select count(*)::int as n
        from pg_index i
        join pg_class c on c.oid = i.indrelid
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
       where c.relname = 'review_queue_items' and i.indkey[0] = a.attnum and i.indpred is null`
    expect(Number(idx!.n), 'нет полного индекса с tenant_id первым').toBeGreaterThan(0)
    const [fk] = await admin`
      select confdeltype from pg_constraint where conname = 'review_queue_items_tenant_id_tenants_id_fk'`
    expect(fk, 'нет FK на tenants').toBeDefined()
    expect(fk!.confdeltype).toBe('c') // cascade
  })

  it('перечни в БД совпадают с shared/enums (CLAUDE.md п. 13)', async () => {
    const def = async (name: string) => String((await admin`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`)[0]!.def)
    const values = (d: string) => [...d.matchAll(/'([a-z_]+)'::text/g)].map(m => m[1])
    expect(values(await def('rqi_task_type_chk'))).toEqual([...REVIEW_TASK_TYPES])
    expect(values(await def('rqi_status_chk'))).toEqual([...REVIEW_QUEUE_STATUSES])
  })

  it('одна единица работы — одна строка: вторая вставка того же источника отклоняется', async () => {
    const sourceId = (await admin`select gen_random_uuid() as id`)[0]!.id as string
    const [row] = await admin`
      insert into review_queue_items (tenant_id, task_type, source_id, user_id, subject_kind)
      values (${tenantId}, 'workshop', ${sourceId}, ${learnerId}, 'employee') returning id`
    syntheticIds.push(row!.id as string)
    await expect(admin`
      insert into review_queue_items (tenant_id, task_type, source_id, user_id, subject_kind)
      values (${tenantId}, 'workshop', ${sourceId}, ${learnerId}, 'employee')`).rejects.toThrow()
  })

  it('изоляция тенанта: чужая строка не видна из сессии с другим tenant_id', async () => {
    const sourceId = (await admin`select gen_random_uuid() as id`)[0]!.id as string
    const [otherUser] = await admin`
      insert into users (tenant_id, kind, full_name, phone) values (${otherTenantId}, 'employee', 'Чужий', '+380679918001')
      on conflict (tenant_id, phone) do update set full_name = excluded.full_name returning id`
    const [row] = await admin`
      insert into review_queue_items (tenant_id, task_type, source_id, user_id, subject_kind)
      values (${otherTenantId}, 'workshop', ${sourceId}, ${otherUser!.id}, 'employee') returning id`
    syntheticIds.push(row!.id as string)

    const seen = await withTenant(tenantId, adminId, async tx =>
      tx.execute(sql`select id from review_queue_items where source_id = ${sourceId}::uuid`))
    expect([...seen as unknown as unknown[]].length, 'строка чужого тенанта видна').toBe(0)
  })
})

// ── Практикум: один писатель на весь жизненный цикл ─────────────────────────────────────────

describe('практикум: постановка, захват, решение, пересдача', () => {
  let workshopId: string
  let submissionId: string

  it('сдача ставит строку в очередь в той же транзакции', async () => {
    const w = await createWorkshop(author(), {
      title: 'PR18 Практикум зі зберігання', description: stem('Опис'), submissionKinds: ['text'],
      minTextLength: 10, criteria: [{ text: 'Дотримано температуру' }], reviewerRule: 'any_mentor', slaHours: 24,
      allowRework: true, maxReworks: 2, status: 'published',
    })
    workshopId = w.id
    workshopIds.push(w.id)

    const sub = await submitWorkshop(learner(), workshopId, { text: 'Зібрав за чек-листом, температура в нормі' })
    expect(sub.ok).toBe(true)
    if (!sub.ok) return
    submissionId = sub.submissionId

    const rows = await queueRows('workshop', submissionId)
    expect(rows.length, 'сдача не попала в очередь').toBe(1)
    expect(rows[0]!.status).toBe('waiting')
    expect(rows[0]!.task_title).toBe('PR18 Практикум зі зберігання')
    expect(rows[0]!.sla_hours).toBe(24)
    expect(rows[0]!.sla_due_at, 'срок проверки не посчитан').not.toBeNull()
  })

  it('subject_kind снят из users.kind один раз и не пересчитывается при смене вида человека', async () => {
    const before = (await queueRows('workshop', submissionId))[0]!
    expect(before.subject_kind).toBe('employee')

    // Человек стал кандидатом уже после сдачи. Очередь этого не переписывает: карточка
    // маскирует ПД по состоянию на момент сдачи (`37` §7.2, решение В-8 × В-2).
    await admin`update users set kind = 'candidate', candidate_state = 'active' where id = ${learnerId}`
    const after = (await queueRows('workshop', submissionId))[0]!
    expect(after.subject_kind).toBe('employee')
    await admin`update users set kind = 'employee', candidate_state = null where id = ${learnerId}`
  })

  it('захват и возврат двигают состояние строки, а не только зеркало в workshop_submissions', async () => {
    const c = await claim(mentor(), submissionId)
    expect(c.ok).toBe(true)
    let row = (await queueRows('workshop', submissionId))[0]!
    expect(row.status).toBe('in_review')
    // С PR-19 захват — отдельные колонки: кто держит карточку, а не кто отвечает за работу.
    // Работа из общего пула назначения при захвате не получает (`37` §4, Р-19.2).
    expect(row.claimed_by).toBe(mentorId)
    expect(row.claimed_at).not.toBeNull()
    expect(row.assigned_reviewer_id).toBeNull()

    await release(mentor(), submissionId)
    row = (await queueRows('workshop', submissionId))[0]!
    expect(row.status).toBe('waiting')
    expect(row.claimed_by).toBeNull()
    expect(row.assigned_reviewer_id).toBeNull()
  })

  it('решение закрывает строку, а не удаляет её; пересдача открывает ту же строку', async () => {
    await claim(mentor(), submissionId)
    const g = await grade(mentor(), submissionId, {
      decision: 'rework',
      criteriaResults: [{ criterionId: (await admin`select criteria_snapshot from workshop_submissions where id = ${submissionId}`)[0]!.criteria_snapshot[0].id, passed: false }],
      comment: 'Додай фото термометра, будь ласка',
    })
    expect(g.ok).toBe(true)

    const closed = await queueRows('workshop', submissionId)
    expect(closed.length, 'строка удалена вместо закрытия').toBe(1)
    expect(closed[0]!.status).toBe('done')
    expect(closed[0]!.completed_at).not.toBeNull()
    expect(closed[0]!.assigned_reviewer_id).toBe(mentorId)

    const re = await submitWorkshop(learner(), workshopId, { text: 'Переробив: додав фото з термометром' })
    expect(re.ok).toBe(true)
    if (!re.ok) return
    // Источник переиспользует ту же строку сдачи — очередь обязана открыть ту же строку.
    expect(re.submissionId).toBe(submissionId)
    const reopened = await queueRows('workshop', submissionId)
    expect(reopened.length, 'пересдача завела вторую строку очереди').toBe(1)
    expect(reopened[0]!.status).toBe('waiting')
    expect(reopened[0]!.completed_at).toBeNull()
    expect(reopened[0]!.assigned_reviewer_id).toBeNull()
  })
})

// ── Развёрнутые ответы теста ───────────────────────────────────────────────────────────────

describe('развёрнутый ответ теста: единица работы — ответ, а не попытка', () => {
  let quizId: string
  let qFree: string
  let attemptId: string
  let answerId: string

  it('отправка попытки с ручным ответом ставит строку на каждый непроверенный ответ', async () => {
    const bank = await createBank(author(), { name: `PR18-банк ${Date.now()}` })
    qFree = (await createQuestion(author(), {
      bankId: bank.id, kind: 'free', stem: stem('Що зробиш, якщо гість чекає понад 20 хвилин?'),
      answer: { criteria: ['Вибачення'], reference: 'Вибачитись' }, isCritical: false, difficulty: 2, points: 2,
      scoringMethod: 'formula', attachFiles: false, negativeMarking: false, tags: [],
    })).id
    const quiz = await createQuiz(author(), { title: 'PR18 Тест залу', kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })
    quizId = quiz.id
    quizIds.push(quizId)
    assignmentIds.push(await assignWithParams(author(), 'test', quizId, { passScore: 60, attemptsAllowed: 3, shuffleQuestions: false, shuffleOptions: false }, [learnerId]))
    await setQuizQuestions(author(), quizId, [{ questionId: qFree, sort: 0 }])

    const r = await startAttempt(learner(), quizId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    attemptId = r.attemptId
    await saveAnswer(learner(), attemptId, qFree, { text: 'Вибачився і запропонував напій' })
    const s = await submitAttempt(learner(), attemptId)
    expect(s.ok && s.status).toBe('review')

    const [a] = await admin`select id from attempt_answers where attempt_id = ${attemptId}`
    answerId = a!.id as string
    const rows = await queueRows('quiz_open_answer', answerId)
    expect(rows.length, 'ответ не попал в очередь').toBe(1)
    expect(rows[0]!.status).toBe('waiting')
    expect(rows[0]!.task_title).toBe('PR18 Тест залу')
  })

  it('оценка ответа закрывает строку и запоминает проверяющего', async () => {
    const g = await gradeManual(mentor(), answerId, { isCorrect: true, comment: 'Добре' })
    expect(g.ok).toBe(true)
    const rows = await queueRows('quiz_open_answer', answerId)
    expect(rows.length).toBe(1)
    expect(rows[0]!.status).toBe('done')
    expect(rows[0]!.assigned_reviewer_id, 'проверяющий не сохранён — статистика §9 не соберётся').toBe(mentorId)
  })

  it('аннулирование попытки закрывает её ответы, а не удаляет строки', async () => {
    const r = await startAttempt(learner(), quizId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    await saveAnswer(learner(), r.attemptId, qFree, { text: 'Друга спроба' })
    await submitAttempt(learner(), r.attemptId)
    const [a2] = await admin`select id from attempt_answers where attempt_id = ${r.attemptId}`
    expect((await queueRows('quiz_open_answer', a2!.id as string))[0]!.status).toBe('waiting')

    await annulAttempt(author(), r.attemptId, 'Технічний збій')
    const rows = await queueRows('quiz_open_answer', a2!.id as string)
    expect(rows.length, 'строки аннулированной попытки удалены').toBe(1)
    expect(rows[0]!.status).toBe('done')
  })
})

// ── Критерии приёмки 37 §13 ────────────────────────────────────────────────────────────────

describe('37 §13 критерий 5: своя работа не появляется ни в одном табе', () => {
  it('практикум, сданный самим наставником, не виден ему ни в «Мої», ни в «Завершені»', async () => {
    const w = await createWorkshop(author(), {
      title: 'PR18 Практикум наставника', description: stem('Опис'), submissionKinds: ['text'],
      minTextLength: 5, criteria: [{ text: 'Зроблено' }], reviewerRule: 'any_mentor', slaHours: 48, status: 'published',
    })
    workshopIds.push(w.id)
    const own = await submitWorkshop(mentor(), w.id, { text: 'Сам здав цю роботу' })
    expect(own.ok).toBe(true)
    if (!own.ok) return

    // В таблице строка есть (её должен увидеть кто-то другой)…
    expect((await queueRows('workshop', own.submissionId)).length).toBe(1)
    // …а в очереди самого наставника её нет ни при каком табе и фильтре.
    for (const tab of ['mine', 'done', 'delegated_in', 'delegated_out'] as const) {
      const q = await listReviewQueue(mentor(), { tab, overdue: false, limit: 200 })
      expect(q.items.some(i => i.sourceId === own.submissionId), `своя работа видна в табе ${tab}`).toBe(false)
    }
    // Коллеге — видна.
    const colleague = await listReviewQueue({ tenantId, actorId: learnerId }, { tab: 'mine', overdue: false, limit: 200 })
    expect(colleague.items.some(i => i.sourceId === own.submissionId)).toBe(true)
  })
})

describe('37 §13 критерий 6: автор материала проверяет, но под плашкой и под запись в журнале', () => {
  it('карточка отдаёт conflict=author, решение проходит, факт записан в audit_log', async () => {
    const w = await createWorkshop(mentor(), {
      title: 'PR18 Практикум свого автора', description: stem('Опис'), submissionKinds: ['text'],
      minTextLength: 5, criteria: [{ text: 'Зроблено' }], reviewerRule: 'any_mentor', slaHours: 48, status: 'published',
    })
    workshopIds.push(w.id)
    const authorIds = (await admin`select author_ids from workshops where id = ${w.id}`)[0]!.author_ids as string[]
    expect(authorIds, 'автор не проставлен — критерий 6 нечем проверить').toContain(mentorId)

    const sub = await submitWorkshop(learner(), w.id, { text: 'Виконав за інструкцією автора' })
    expect(sub.ok).toBe(true)
    if (!sub.ok) return
    await claim(mentor(), sub.submissionId)

    const card = await submissionForReview(mentor(), sub.submissionId)
    expect(card!.conflict, 'плашка автора не показана').toBe('author')

    const criterionId = (await admin`select criteria_snapshot from workshop_submissions where id = ${sub.submissionId}`)[0]!.criteria_snapshot[0].id
    const g = await grade(mentor(), sub.submissionId, {
      decision: 'accepted',
      criteriaResults: [{ criterionId, passed: true }],
    })
    expect(g.ok, 'автору запретили решение — критерий 6 требует обратного').toBe(true)

    const [log] = await admin`
      select id from audit_log
       where action = 'review.author_conflict' and entity_id = ${sub.submissionId} and actor_id = ${mentorId}`
    expect(log, 'факт проверки автором не записан в audit_log (основание отчёта 37 §9.2)').toBeDefined()
  })

  it('своя работа даёт conflict=self, чужая без авторства — null', async () => {
    const [own, none] = await withTenant(tenantId, mentorId, async tx => [
      await reviewConflict(tx, { actorId: mentorId, subjectUserId: mentorId, authorIds: [] }),
      await reviewConflict(tx, { actorId: mentorId, subjectUserId: learnerId, authorIds: [adminId] }),
    ])
    expect(own).toBe('self')
    expect(none).toBeNull()
  })
})

// ── Контракт ответа: total и курсор ────────────────────────────────────────────────────────

describe('ответ /review/queue несёт total и курсор', () => {
  it('страницы не пересекаются, total не зависит от размера страницы', async () => {
    const w = await createWorkshop(author(), {
      title: 'PR18 Практикум сторінок', description: stem('Опис'), submissionKinds: ['text'],
      minTextLength: 5, criteria: [{ text: 'Зроблено' }], reviewerRule: 'any_mentor', slaHours: 48, status: 'published',
    })
    workshopIds.push(w.id)

    // Три строки очереди от трёх разных людей — через enqueueReview(), единственную точку.
    const people = [learnerId, adminId, learnerId]
    const sources: string[] = []
    for (let i = 0; i < 3; i++) {
      const sourceId = (await admin`select gen_random_uuid() as id`)[0]!.id as string
      sources.push(sourceId)
      await withTenant(tenantId, adminId, tx => enqueueReview(tx, {
        tenantId,
        taskType: 'offline_confirm',
        sourceId,
        userId: people[i]!,
        taskTitle: `PR18 підтвердження ${i}`,
        submittedAt: new Date(Date.now() - (3 - i) * 3_600_000),
      }))
      syntheticIds.push((await admin`select id from review_queue_items where source_id = ${sourceId}`)[0]!.id as string)
    }

    const first = await listReviewQueue(mentor(), { tab: 'mine', taskType: 'offline_confirm', overdue: false, limit: 2 })
    expect(first.total, 'total не посчитан').toBe(3)
    expect(first.items.length).toBe(2)
    expect(first.cursor, 'курсор не выдан при наличии следующей страницы').toBeTruthy()

    const second = await listReviewQueue(mentor(), { tab: 'mine', taskType: 'offline_confirm', overdue: false, limit: 2, cursor: first.cursor! })
    expect(second.total).toBe(3)
    expect(second.items.length).toBe(1)
    expect(second.cursor).toBeNull()
    const ids = new Set([...first.items, ...second.items].map(i => i.id))
    expect(ids.size, 'страницы пересеклись').toBe(3)

    // Фильтр «Тип суб'єкта» работает по снимку, а не по текущему `users.kind`.
    const onlyEmployees = await listReviewQueue(mentor(), { tab: 'mine', taskType: 'offline_confirm', subjectKind: 'employee', overdue: false, limit: 50 })
    expect(onlyEmployees.total).toBe(3)

    // Закрытие снимает работу с таба «Мої» и переносит в «Завершені» — без удаления строк.
    await withTenant(tenantId, mentorId, tx => closeReview(tx, { taskType: 'offline_confirm', sourceIds: sources, reviewerId: mentorId }))
    const after = await listReviewQueue(mentor(), { tab: 'mine', taskType: 'offline_confirm', overdue: false, limit: 50 })
    expect(after.total).toBe(0)
    const done = await listReviewQueue(mentor(), { tab: 'done', taskType: 'offline_confirm', overdue: false, limit: 50 })
    expect(done.total).toBe(3)
    expect((await admin`select count(*)::int as n from review_queue_items where source_id in ${admin(sources)}`)[0]!.n).toBe(3)
  })
})
