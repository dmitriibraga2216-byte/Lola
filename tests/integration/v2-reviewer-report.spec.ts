import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * misc-tails-3, часть 1 (docs/v2/37 §9.2, §7.19; `44` Р-MT.1.1…Р-MT.1.4):
 * - «Робота перевіряючих» — колонки §9.2 по источникам `review.stats_rollup`, считается при
 *   запросе: решения, доли, медианы, передачи, просрочка, эскалации, свой контент; фильтры
 *   период / точка / тип задания / тип субъекта; область роли и кандидаты по `candidate.view`;
 * - подъём по дереву у уведомлений «перегружен» и «итог делегирования»: недействующий
 *   руководитель пропускается, а не получает уведомление.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { enqueueReview } = await import('../../server/services/reviewQueue')
const { notifyOverloaded } = await import('../../server/services/reviewRouting')
const { tenantAdmins } = await import('../../server/services/reviewPeople')
const { reviewerReportPeriod, reviewerWorkExportRows, reviewerWorkReport } = await import('../../server/services/reviewReports')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const H = 3_600_000
const PHONE = '+38067919200'
let tenantId: string
let otherTenantId: string
let lazareva: string
let otherLocation: string
let positionId: string
let prevManager: string | null
const people: Record<string, string> = {}

const PEOPLE: [key: string, name: string, kind: 'employee' | 'candidate'][] = [
  ['a', 'RWR Перевіряюча А', 'employee'],
  ['b', 'RWR Перевіряючий Б', 'employee'],
  ['m', 'RWR Керівник', 'employee'],
  ['learner', 'RWR Учень', 'employee'],
  ['cand', 'RWR Кандидат', 'candidate'],
]

const today = new Date().toISOString().slice(0, 10)
const all = { tenantId: '', actorId: '', scope: null as string[] | null, candidates: true }
const ctx = (over: Partial<typeof all> = {}) => ({ ...all, tenantId, actorId: people.m!, ...over })
const ago = (h: number) => new Date(Date.now() - h * H)

async function item(opts: { title: string, userId?: string, taskType?: 'workshop' | 'offline_confirm', locationId?: string, subjectKind?: 'employee' | 'candidate' }): Promise<{ id: string, sourceId: string }> {
  const sourceId = (await admin`select gen_random_uuid() as id`)[0]!.id as string
  const id = await withTenant(tenantId, people.m!, tx => enqueueReview(tx, {
    tenantId,
    taskType: opts.taskType ?? 'workshop',
    sourceId,
    userId: opts.userId ?? people.learner!,
    taskTitle: `RWR ${opts.title}`,
  }))
  if (opts.locationId) await admin`update review_queue_items set location_id = ${opts.locationId} where id = ${id}`
  return { id, sourceId }
}

/** Решение проверяющего — строка журнала, как её пишет `workshops.ts`/`attempts.ts`. */
async function decide(reviewer: string, sourceId: string, decision: 'accepted' | 'rejected' | 'rework', at = new Date()) {
  await admin`insert into audit_log (tenant_id, actor_id, action, entity, entity_id, after, created_at)
    values (${tenantId}, ${people[reviewer]!}, 'workshop.grade', 'workshop_submission', ${sourceId}, ${admin.json({ decision })}, ${at})`
}

/** Закрытая работа: сдана → взята через `react` часов → решена через `review` часов. */
async function close(itemId: string, reviewer: string, react: number, review: number, breached = false) {
  const submitted = ago(react + review + 1)
  await admin`update review_queue_items set status = 'done', assigned_reviewer_id = ${people[reviewer]!},
    submitted_at = ${submitted}, claimed_at = ${new Date(submitted.getTime() + react * H)},
    completed_at = ${new Date(submitted.getTime() + (react + review) * H)},
    sla_breached_at = ${breached ? submitted : null} where id = ${itemId}`
}

async function cleanup() {
  const ids = (await admin`select id from users where tenant_id = ${tenantId} and phone like ${`${PHONE}%`}`).map(r => r.id as string)
  if (!ids.length) return
  await admin`update locations set manager_id = null where manager_id in ${admin(ids)}`
  await admin`delete from review_delegations where from_user_id in ${admin(ids)} or to_user_id in ${admin(ids)}`
  await admin`delete from review_queue_items where user_id in ${admin(ids)}`
  await admin`delete from reviewer_capacity where user_id in ${admin(ids)}`
  await admin`delete from notifications where user_id in ${admin(ids)} or payload->>'name' like 'RWR %'`
  await admin`delete from audit_log where actor_id in ${admin(ids)}`
  await admin`delete from user_roles where user_id in ${admin(ids)}`
  await admin`delete from user_placements where user_id in ${admin(ids)}`
  await admin`delete from users where id in ${admin(ids)}`
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  otherTenantId = (await admin`
    insert into tenants (slug, name) values ('rwr-other', 'RWR other') on conflict (slug) do update set name = excluded.name returning id`)[0]!.id as string
  const [loc] = await admin`select id, manager_id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`
  lazareva = loc!.id as string
  otherLocation = (await admin`select id from locations where tenant_id = ${tenantId} and id <> ${lazareva} limit 1`)[0]!.id as string
  positionId = (await admin`select id from positions where tenant_id = ${tenantId} and code = 'cook-hot'`)[0]!.id as string
  await cleanup()
  prevManager = (loc!.manager_id as string | null) ?? null
  let n = 0
  for (const [key, name, kind] of PEOPLE) {
    const [u] = await admin`
      insert into users (tenant_id, kind, full_name, phone, status, candidate_state)
      values (${tenantId}, ${kind}, ${name}, ${`${PHONE}${++n}`}, 'active', ${kind === 'candidate' ? 'active' : null})
      returning id`
    people[key] = u!.id as string
    await admin`insert into user_placements (tenant_id, user_id, location_id, position_id) values (${tenantId}, ${u!.id}, ${lazareva}, ${positionId})`
  }
  await admin`update locations set manager_id = ${people.m!} where id = ${lazareva}`

  // А: три решения (2 приняты, 1 на доработку), две закрытые работы с медианами 1 ч и 3 ч
  // реакции, одна просрочена; одна передача Б; эскалация; одна проверка своего контента.
  const w1 = await item({ title: 'практикум 1' })
  const w2 = await item({ title: 'практикум 2' })
  const w3 = await item({ title: 'практикум 3' })
  await decide('a', w1.sourceId, 'accepted')
  await decide('a', w2.sourceId, 'accepted')
  await decide('a', w3.sourceId, 'rework')
  await close(w1.id, 'a', 1, 2)
  await close(w2.id, 'a', 3, 4, true)
  await admin`insert into audit_log (tenant_id, actor_id, action, entity, entity_id, after)
    values (${tenantId}, ${people.a!}, 'review.author_conflict', 'workshop_submission', ${w1.sourceId}, '{}'::jsonb)`
  const d1 = await item({ title: 'передана' })
  await admin`insert into review_delegations (tenant_id, queue_item_id, from_user_id, to_user_id, reason_code, due_at)
    values (${tenantId}, ${d1.id}, ${people.a!}, ${people.b!}, 'workload', ${new Date(Date.now() + 24 * H)})`
  await admin`insert into review_sla_events (tenant_id, queue_item_id, reviewer_id, event) values (${tenantId}, ${d1.id}, ${people.a!}, 'escalated')`

  // Б: одно решение по очной работе в другой точке и одно — по работе кандидата.
  const o1 = await item({ title: 'очна', taskType: 'offline_confirm', locationId: otherLocation })
  await decide('b', o1.sourceId, 'rejected')
  const c1 = await item({ title: 'кандидат', userId: people.cand! })
  await decide('b', c1.sourceId, 'accepted')

  // Старое решение вне периода по умолчанию — 40 суток назад.
  const old = await item({ title: 'давня' })
  await decide('b', old.sourceId, 'accepted', ago(40 * 24))
})

afterAll(async () => {
  await admin`update locations set manager_id = ${prevManager} where id = ${lazareva}`
  await cleanup()
  await admin`delete from tenants where id = ${otherTenantId}`
  await admin.end()
})

const rowOf = (rows: { reviewerId: string }[], key: string) => rows.find(r => r.reviewerId === people[key]!) as Record<string, unknown> | undefined

describe('«Робота перевіряючих» (37 §9.2)', () => {
  it('период по умолчанию — 30 суток по сегодня; «по» без «з» — 30 суток до неё', () => {
    expect(reviewerReportPeriod({}, new Date('2026-10-01T12:00:00Z'))).toEqual({ from: '2026-09-02', to: '2026-10-01' })
    expect(reviewerReportPeriod({ to: '2026-03-31' })).toEqual({ from: '2026-03-02', to: '2026-03-31' })
    expect(reviewerReportPeriod({ from: '2026-09-20', to: '2026-09-25' })).toEqual({ from: '2026-09-20', to: '2026-09-25' })
  })

  it('колонки §9.2 у проверяющей А: решения, доли, медианы, передачи, просрочка, эскалация, свой контент', async () => {
    const r = await reviewerWorkReport(ctx(), {})
    expect(r.to).toBe(today)
    const a = rowOf(r.rows, 'a')
    expect(a).toMatchObject({
      reviewerName: 'RWR Перевіряюча А',
      locations: ['Лазарева'],
      reviewed: 3, accepted: 2, rejected: 0, rework: 1,
      acceptedShare: 0.667,
      medianReactSec: 2 * 3600,
      medianReviewSec: 3 * 3600,
      delegatedOut: 1, delegatedIn: 0,
      delegatedShare: 0.25,
      breached: 1, escalated: 1, ownContent: 1,
    })
    expect(rowOf(r.rows, 'b')).toMatchObject({ reviewed: 2, accepted: 1, rejected: 1, delegatedIn: 1, delegatedOut: 0, delegatedShare: 0, medianReactSec: null })
    // Проверяемые без решений и передач строк не дают; кандидат не проверяющий никогда.
    expect(rowOf(r.rows, 'learner')).toBeUndefined()
    expect(rowOf(r.rows, 'cand')).toBeUndefined()
  })

  it('период: решение 40 суток назад попадает только в явный период', async () => {
    const from = new Date(Date.now() - 45 * 24 * H).toISOString().slice(0, 10)
    const wide = rowOf((await reviewerWorkReport(ctx(), { from, to: today })).rows, 'b')
    expect(wide).toMatchObject({ reviewed: 3, accepted: 2 })
    const past = await reviewerWorkReport(ctx(), { from, to: new Date(Date.now() - 35 * 24 * H).toISOString().slice(0, 10) })
    expect(rowOf(past.rows, 'b')).toMatchObject({ reviewed: 1 })
    expect(rowOf(past.rows, 'a')).toBeUndefined()
  })

  it('фильтры: тип задания, точка работы, тип субъекта', async () => {
    const offline = await reviewerWorkReport(ctx(), { taskType: 'offline_confirm' })
    expect(rowOf(offline.rows, 'b')).toMatchObject({ reviewed: 1, rejected: 1 })
    expect(rowOf(offline.rows, 'a')).toBeUndefined()
    const other = await reviewerWorkReport(ctx(), { locationId: otherLocation })
    expect(other.rows.map(r => r.reviewerId)).toEqual([people.b!])
    const cand = await reviewerWorkReport(ctx(), { subjectKind: 'candidate' })
    expect(rowOf(cand.rows, 'b')).toMatchObject({ reviewed: 1, accepted: 1 })
    expect(rowOf(cand.rows, 'a')).toBeUndefined()
  })

  it('область роли — только работы своих точек; без candidate.view работа кандидата не считается', async () => {
    const local = await reviewerWorkReport(ctx({ scope: [lazareva], candidates: false }), {})
    // Б: очная — в другой точке, кандидатская — скрыта; остаётся только передача от А.
    expect(rowOf(local.rows, 'b')).toMatchObject({ reviewed: 0, delegatedIn: 1 })
    expect(rowOf(local.rows, 'a')).toMatchObject({ reviewed: 3 })
    expect((await reviewerWorkReport(ctx({ candidates: false }), { subjectKind: 'candidate' })).rows).toEqual([])
    expect((await reviewerWorkReport(ctx({ scope: [] }), {})).rows).toEqual([])
  })

  it('чужой тенант своих строк не видит', async () => {
    const r = await reviewerWorkReport({ tenantId: otherTenantId, actorId: people.m!, scope: null, candidates: true }, {})
    expect(r.rows.some(x => Object.values(people).includes(x.reviewerId))).toBe(false)
  })

  it('выгрузка — те же строки, ключи в порядке колонок §9.2', async () => {
    const r = await reviewerWorkReport(ctx(), {})
    const out = reviewerWorkExportRows(r.rows)
    expect(out).toHaveLength(r.rows.length)
    expect(Object.keys(out[0]!)).toEqual(['reviewer', 'locations', 'reviewed', 'accepted', 'rejected', 'rework', 'accepted_share',
      'median_react_sec', 'median_review_sec', 'delegated_out', 'delegated_in', 'delegated_share', 'breached', 'escalated', 'own_content'])
  })
})

describe('подъём по дереву без флага: недействующий руководитель пропускается (37 §7.19, §12)', () => {
  it('«перегружен» при заблокированном руководителе уходит выше (здесь — администратору), а не ему', async () => {
    await admin`delete from reviewer_capacity where user_id = ${people.a!}`
    await admin`insert into reviewer_capacity (tenant_id, user_id, max_open_items) values (${tenantId}, ${people.a!}, 1)`
    const open = await item({ title: 'відкрита' })
    await admin`update review_queue_items set assigned_reviewer_id = ${people.a!}, status = 'waiting' where id = ${open.id}`
    await admin`update users set is_blocked = true where id = ${people.m!}`
    try {
      await withTenant(tenantId, null, tx => notifyOverloaded(tx, tenantId, people.a!))
      const sent = await admin`select user_id from notifications where code = 'review_overloaded' and payload->>'name' = 'RWR Перевіряюча А'`
      const admins = await withTenant(tenantId, null, tx => tenantAdmins(tx))
      expect(sent.map(s => s.user_id)).toEqual([admins.find(id => id !== people.a!)])
      expect(sent.map(s => s.user_id)).not.toContain(people.m!)
    }
    finally {
      await admin`update users set is_blocked = false where id = ${people.m!}`
    }
  })

  it('действующий руководитель — получает сам, как и раньше', async () => {
    await admin`delete from notifications where code = 'review_overloaded' and payload->>'name' = 'RWR Перевіряюча А'`
    await withTenant(tenantId, null, tx => notifyOverloaded(tx, tenantId, people.a!))
    const sent = await admin`select user_id from notifications where code = 'review_overloaded' and payload->>'name' = 'RWR Перевіряюча А'`
    expect(sent.map(s => s.user_id)).toEqual([people.m!])
  })
})
