import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SYSTEM_ROLES } from '../../shared/domain/roles'

/**
 * Хвосты блока «Проверка и время» (review-time-tails; docs/v2/37):
 * - «Відхилення» работы в очереди и в карточке (§5.1, §5.2, §7.14) — считает сервер;
 * - выгрузка экрана «Черга перевірки» (§9.1) — те же строки, колонки §9.1 по порядку;
 * - «Ви навчали цю людину за цим треком» (§7.9) — наставник траектории с узлом работы;
 * - журнал «Делегування» (§9.4) — область роли, фильтры, кандидаты только с `candidate.view`.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { enqueueReview, listReviewQueue, reviewQueueExportRows } = await import('../../server/services/reviewQueue')
const { delegateItem, reassignItem, revokeDelegation } = await import('../../server/services/reviewDelegation')
const { getReviewItem } = await import('../../server/services/reviewCard')
const { reviewActorOf } = await import('../../server/services/reviewActor')
const { delegationJournal, delegationJournalExportRows } = await import('../../server/services/reviewReports')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const H = 3_600_000
let tenantId: string
let lazareva: string
let otherLocation: string
let positionId: string
let courseId: string
let trajectoryId: string
let prevManager: string | null
const people: Record<string, string> = {}

type Role = 'mentor' | 'manager'
const PEOPLE: [key: string, name: string, phone: string, role: Role | null, kind: 'employee' | 'candidate'][] = [
  ['a', 'RTT Наставник А', '+380679191001', 'mentor', 'employee'],
  ['b', 'RTT Наставник Б', '+380679191002', 'mentor', 'employee'],
  ['m', 'RTT Керівник', '+380679191003', 'manager', 'employee'],
  ['learner', 'RTT Учень', '+380679191004', null, 'employee'],
  ['cand', 'RTT Кандидат', '+380679191005', null, 'candidate'],
]

const actor = (key: string) => {
  const role = PEOPLE.find(p => p[0] === key)![3] ?? 'mentor'
  return reviewActorOf({ tenantId, userId: people[key]!, grants: [{ scopes: [...SYSTEM_ROLES[role]!.scopes], scopeType: 'location', scopeId: lazareva }] })
}
const ctxOf = (key: string) => ({ tenantId, actorId: people[key]! })
const inH = (h: number) => new Date(Date.now() + h * H).toISOString()

async function newItem(title: string, opts: { userId?: string, estimatedSeconds?: number | null, trackId?: string | null } = {}): Promise<string> {
  const sourceId = (await admin`select gen_random_uuid() as id`)[0]!.id as string
  return withTenant(tenantId, people.m!, tx => enqueueReview(tx, {
    tenantId,
    taskType: 'offline_confirm',
    sourceId,
    userId: opts.userId ?? people.learner!,
    taskTitle: `RTT ${title}`,
    estimatedSeconds: opts.estimatedSeconds ?? null,
    trackId: opts.trackId ?? null,
  }))
}
async function assignTo(itemId: string, key: string) {
  const r = await reassignItem(actor('m'), itemId, { toUserId: people[key]!, reason: 'Призначення для перевірки' })
  expect(r.ok, JSON.stringify(r)).toBe(true)
}
/** Время работы пишет только свёртка; в тесте — прямо в строку, как её итог. */
async function setTime(itemId: string, content: number, attempt: number, confidence = 'ok') {
  await admin`update review_queue_items set content_seconds = ${content}, attempt_seconds = ${attempt}, time_confidence = ${confidence} where id = ${itemId}`
}

async function cleanup() {
  const ids = (await admin`select id from users where tenant_id = ${tenantId} and phone like '+38067919100%'`).map(r => r.id as string)
  await admin`delete from trajectories where tenant_id = ${tenantId} and title = 'RTT траєкторія'`
  if (ids.length) {
    await admin`update locations set manager_id = null where manager_id in ${admin(ids)}`
    await admin`delete from review_delegations where from_user_id in ${admin(ids)} or to_user_id in ${admin(ids)}`
    await admin`delete from review_queue_items where user_id in ${admin(ids)}`
    await admin`delete from reviewer_capacity where user_id in ${admin(ids)}`
    await admin`delete from notifications where user_id in ${admin(ids)}`
    await admin`delete from audit_log where actor_id in ${admin(ids)}`
    await admin`delete from user_roles where user_id in ${admin(ids)}`
    await admin`delete from user_placements where user_id in ${admin(ids)}`
    await admin`delete from users where id in ${admin(ids)}`
  }
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  const [loc] = await admin`select id, manager_id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`
  lazareva = loc!.id as string
  otherLocation = (await admin`select id from locations where tenant_id = ${tenantId} and id <> ${lazareva} limit 1`)[0]!.id as string
  positionId = (await admin`select id from positions where tenant_id = ${tenantId} and code = 'cook-hot'`)[0]!.id as string
  courseId = (await admin`select id from courses where tenant_id = ${tenantId} and published_version_id is not null order by created_at limit 1`)[0]!.id as string
  await cleanup()
  const ours = (await admin`select id from users where tenant_id = ${tenantId} and phone like '+38067919100%'`).map(r => r.id as string)
  prevManager = ours.includes(loc!.manager_id as string) ? null : (loc!.manager_id as string | null) ?? null
  for (const [key, name, phone, role, kind] of PEOPLE) {
    const [u] = await admin`
      insert into users (tenant_id, kind, full_name, phone, status, candidate_state)
      values (${tenantId}, ${kind}, ${name}, ${phone}, 'active', ${kind === 'candidate' ? 'active' : null})
      on conflict (tenant_id, phone) do update set full_name = excluded.full_name, kind = excluded.kind, candidate_state = excluded.candidate_state, status = 'active', is_blocked = false
      returning id`
    people[key] = u!.id as string
    await admin`insert into user_placements (tenant_id, user_id, location_id, position_id) values (${tenantId}, ${u!.id}, ${lazareva}, ${positionId})`
    if (role) {
      await admin`
        insert into user_roles (tenant_id, user_id, role_id, scope_type, scope_id)
        values (${tenantId}, ${u!.id}, (select id from roles where tenant_id = ${tenantId} and code = ${role}), 'location', ${lazareva})`
    }
  }
  await admin`update locations set manager_id = ${people.m!} where id = ${lazareva}`
  // Траектория учня с курсом узлом, наставник — А (узел «Призначити наставника» уже сработал)
  const [t] = await admin`insert into trajectories (tenant_id, title, status) values (${tenantId}, 'RTT траєкторія', 'published') returning id`
  trajectoryId = t!.id as string
  await admin`insert into trajectory_nodes (tenant_id, trajectory_id, kind, content_type, content_id) values (${tenantId}, ${trajectoryId}, 'task', 'course', ${courseId})`
  await admin`insert into trajectory_enrollments (tenant_id, trajectory_id, user_id, status, mentor_id) values (${tenantId}, ${trajectoryId}, ${people.learner!}, 'in_progress', ${people.a!})`
})

afterAll(async () => {
  await admin`update locations set manager_id = ${prevManager} where id = ${lazareva}`
  await cleanup()
  await admin.end()
})

describe('«Відхилення» в очереди и карточке (37 §5.1, §5.2, §7.14)', () => {
  it('факт втрое больше плана — «повільніше», вдвое меньше половины — «швидше», в норме — множитель без значка', async () => {
    const slow = await newItem('повільно', { estimatedSeconds: 600 })
    const fast = await newItem('швидко', { estimatedSeconds: 600 })
    const ok = await newItem('в нормі', { estimatedSeconds: 600 })
    const noPlan = await newItem('без плану', { estimatedSeconds: null })
    const unreliable = await newItem('неповні дані', { estimatedSeconds: 600 })
    await setTime(slow, 1500, 300)
    await setTime(fast, 120, 60)
    await setTime(ok, 400, 300)
    await setTime(noPlan, 400, 300)
    await setTime(unreliable, 3000, 0, 'unreliable')
    const rows = (await listReviewQueue(ctxOf('a'), { tab: 'mine', taskType: 'offline_confirm', overdue: false, limit: 200 })).items
    const by = (id: string) => rows.find(r => r.id === id)!
    expect([by(slow).deviation, by(slow).deviationFactor]).toEqual(['too_slow', 3])
    expect([by(fast).deviation, by(fast).deviationFactor]).toEqual(['too_fast', 0.3])
    expect([by(ok).deviation, by(ok).deviationFactor]).toEqual(['none', 1.17])
    expect([by(noPlan).deviation, by(noPlan).deviationFactor]).toEqual(['no_data', null])
    expect([by(unreliable).deviation, by(unreliable).deviationFactor]).toEqual(['no_data', null])
    const card = await getReviewItem(actor('a'), slow)
    expect(card!.item).toMatchObject({ estimatedSeconds: 600, contentSeconds: 1500, attemptSeconds: 300, deviation: 'too_slow', deviationFactor: 3 })
  })
})

describe('выгрузка «Черга перевірки» (37 §9.1)', () => {
  it('колонки §9.1 по порядку, строки — те же, что на экране; своей работы нет', async () => {
    const rows = await reviewQueueExportRows(ctxOf('a'), { tab: 'mine', taskType: 'offline_confirm', overdue: false })
    const screen = (await listReviewQueue(ctxOf('a'), { tab: 'mine', taskType: 'offline_confirm', overdue: false, limit: 200 })).items
    expect(rows.length).toBe(screen.length)
    expect(Object.keys(rows[0]!)).toEqual([
      'full_name', 'subject_kind', 'location', 'track', 'task_type', 'task_title', 'attempts', 'estimated_min', 'content_min',
      'attempt_min', 'deviation', 'deviation_factor', 'confidence', 'completed_at', 'reviewer', 'delegated_by', 'sla_due_at', 'status',
    ])
    const slow = rows.find(r => r.task_title === 'RTT повільно')!
    expect(slow).toMatchObject({ estimated_min: 10, content_min: 25, attempt_min: 5, deviation: 'too_slow', deviation_factor: 3, full_name: 'RTT Учень' })
    // Работа самого проверяющего не попадает ни на экран, ни в файл (37 §7.7)
    await newItem('своя', { userId: people.a! })
    const again = await reviewQueueExportRows(ctxOf('a'), { tab: 'mine', taskType: 'offline_confirm', overdue: false })
    expect(again.some(r => r.task_title === 'RTT своя')).toBe(false)
  })
})

describe('«Ви навчали цю людину за цим треком» (37 §7.9)', () => {
  it('наставник траектории с курсом работы видит плашку, другой проверяющий — нет; решение не блокируется', async () => {
    const itemId = await newItem('наставник', { trackId: courseId })
    const forA = await getReviewItem(actor('a'), itemId)
    expect(forA!.trainedByMe).toBe(true)
    expect(forA!.conflict).toBeNull()
    expect(forA!.can.delegate).toBe(true)
    expect((await getReviewItem(actor('b'), itemId))!.trainedByMe).toBe(false)
    // Работа вне этого трека — плашки нет
    const other = await newItem('інший трек', { trackId: null })
    expect((await getReviewItem(actor('a'), other))!.trainedByMe).toBe(false)
  })

  it('«Передати іншому» — обычное делегирование с причиной conflict_of_interest', async () => {
    const itemId = await newItem('передати', { trackId: courseId })
    await assignTo(itemId, 'a')
    const r = await delegateItem(actor('a'), itemId, { toUserId: people.b!, reasonCode: 'conflict_of_interest', dueAt: inH(24), notify: false })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect((await getReviewItem(actor('b'), itemId))!.trainedByMe).toBe(false)
  })

  it('отменённое прохождение траектории — не наставничество', async () => {
    await admin`update trajectory_enrollments set cancelled_at = now() where trajectory_id = ${trajectoryId}`
    const itemId = await newItem('скасовано', { trackId: courseId })
    expect((await getReviewItem(actor('a'), itemId))!.trainedByMe).toBe(false)
    await admin`update trajectory_enrollments set cancelled_at = null where trajectory_id = ${trajectoryId}`
  })
})

describe('журнал «Делегування» (37 §9.4)', () => {
  it('строка на звено с колонками §9.4; фильтры сужают; чужая точка и пустая область — пусто', async () => {
    const itemId = await newItem('журнал')
    await assignTo(itemId, 'a')
    const d = await delegateItem(actor('a'), itemId, { toUserId: people.b!, reasonCode: 'other', reasonText: 'Потрібен другий погляд', dueAt: inH(30), notify: false })
    expect(d.ok).toBe(true)
    const ctx = { tenantId, actorId: people.m!, scope: [lazareva], candidates: false }
    const all = await delegationJournal(ctx, {})
    const mineRow = all.rows.find(r => r.taskTitle === 'RTT журнал')!
    expect(mineRow).toMatchObject({ fromName: 'RTT Наставник А', toName: 'RTT Наставник Б', depth: 1, reasonCode: 'other', reasonText: 'Потрібен другий погляд', state: 'active', resolvedAt: null, locationName: 'Лазарева' })
    expect((await delegationJournal(ctx, { fromUserId: people.b! })).rows.some(r => r.id === mineRow.id)).toBe(false)
    expect((await delegationJournal(ctx, { toUserId: people.b!, reasonCode: 'other', state: 'active' })).rows.some(r => r.id === mineRow.id)).toBe(true)
    expect((await delegationJournal(ctx, { state: 'resolved' })).rows.some(r => r.id === mineRow.id)).toBe(false)
    expect((await delegationJournal(ctx, { to: '2000-01-01' })).rows.some(r => r.id === mineRow.id)).toBe(false)
    expect((await delegationJournal({ ...ctx, scope: [otherLocation] }, {})).rows.some(r => r.id === mineRow.id)).toBe(false)
    expect((await delegationJournal({ ...ctx, scope: [] }, {})).rows).toEqual([])
    expect((await delegationJournal(ctx, { locationId: otherLocation })).rows.some(r => r.id === mineRow.id)).toBe(false)

    // Отзыв закрывает звено: стан и дата завершения доходят до журнала
    const revoked = await revokeDelegation(actor('a'), d.ok ? d.delegationId : '', {})
    expect(revoked.ok, JSON.stringify(revoked)).toBe(true)
    const after = (await delegationJournal(ctx, {})).rows.find(r => r.id === mineRow.id)!
    expect(after.state).toBe('revoked_by_author')
    expect(after.resolvedAt).not.toBeNull()

    const file = delegationJournalExportRows([after])
    expect(Object.keys(file[0]!)).toEqual(['date', 'from', 'to', 'depth', 'task_type', 'task', 'location', 'reason', 'reason_text', 'state', 'resolved_at'])
  })

  it('работа кандидата — только смотрящему с candidate.view (#143)', async () => {
    const itemId = await newItem('кандидат', { userId: people.cand! })
    await assignTo(itemId, 'a')
    const d = await delegateItem(actor('a'), itemId, { toUserId: people.b!, reasonCode: 'workload', dueAt: inH(30), notify: false })
    expect(d.ok, JSON.stringify(d)).toBe(true)
    const ctx = { tenantId, actorId: people.m!, scope: null, candidates: false }
    expect((await delegationJournal(ctx, {})).rows.some(r => r.taskTitle === 'RTT кандидат')).toBe(false)
    expect((await delegationJournal({ ...ctx, candidates: true }, {})).rows.some(r => r.taskTitle === 'RTT кандидат')).toBe(true)
  })
})
