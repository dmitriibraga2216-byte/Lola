import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SYSTEM_ROLES } from '../../shared/domain/roles'

/**
 * PR-19 пакета `docs/v2` (`45-plan.md`): делегирование, распределение, SLA
 * (`docs/v2/37-review-delegation.md`, решения `44` В-2, В-13).
 *
 * Критерии приёмки `37` §13, закреплённые за этим PR: **1, 2, 3, 4, 12, 13, 14** — здесь;
 * **15** и сквозная проверка 20 (`42` §5) — отдельным файлом
 * `v2-crosscheck-20-delegation-pd.spec.ts` (по одному файлу на сквозную проверку, HANDOFF §7.2).
 *
 * Условие выхода PR-19 проверяется в каждом сценарии, где работа движется: **`sla_due_at`
 * элемента не меняется** ни делегированием, ни отзывом, ни возвратом по сроку, ни
 * переназначением, ни перебросом очереди отсутствующего.
 *
 * Люди — свои (`PR19 …`), со своими ролями на точке «Лазарева»; работы — свои, через
 * `enqueueReview()`. Общий тенант «Каппі» после файла возвращается как был.
 */

const { enqueueReview, listReviewQueue, claimReview, reviewQueueCounts } = await import('../../server/services/reviewQueue')
const { delegateItem, revokeDelegation, expireDelegations, reassignItem, bulkDelegate, delegateTargets } = await import('../../server/services/reviewDelegation')
const { createRoutingRule, updateRoutingRule, deleteRoutingRule, listRoutingRules, rebalanceTenant } = await import('../../server/services/reviewRouting')
const { createAbsence, applyAbsences, updateCapacity, listWorkload } = await import('../../server/services/reviewWorkload')
const { reviewSlaScan, reviewStatsRollup } = await import('../../server/services/reviewSla')
const { getReviewItem } = await import('../../server/services/reviewCard')
const { reviewActorOf } = await import('../../server/services/reviewActor')
const { createWorkshop, submitWorkshop, claim, grade } = await import('../../server/services/workshops')
const { withTenant } = await import('../../server/utils/withTenant')
const { DELEGATE_ERRORS, REVOKE_ERRORS } = await import('../../server/utils/reviewErrors')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const H = 3_600_000
let tenantId: string
let lazareva: string
let positionId: string
let adminId: string
let prevManager: string | null
const people: Record<string, string> = {}
const workshopIds: string[] = []
const ruleIds: string[] = []

type Role = 'mentor' | 'manager'
const PEOPLE: [key: string, name: string, phone: string, role: Role | null][] = [
  ['a', 'PR19 Наставник А', '+380679190001', 'mentor'],
  ['b', 'PR19 Наставник Б', '+380679190002', 'mentor'],
  ['c', 'PR19 Наставник В', '+380679190003', 'mentor'],
  ['d', 'PR19 Наставник Г', '+380679190004', 'mentor'],
  ['s', 'PR19 Заміщувач', '+380679190005', 'mentor'],
  ['m', 'PR19 Керівник точки', '+380679190006', 'manager'],
  ['learner', 'PR19 Учень', '+380679190007', null],
  ['colleague', 'PR19 Колега без прав', '+380679190008', null],
]

/** Проверяющий с правами своей роли на точке «Лазарева» — как `loadAccess()` собрал бы их из сессии. */
const actor = (key: string) => {
  const role = PEOPLE.find(p => p[0] === key)![3] ?? 'mentor'
  return reviewActorOf({ tenantId, userId: people[key]!, grants: [{ scopes: [...SYSTEM_ROLES[role]!.scopes], scopeType: 'location', scopeId: lazareva }] })
}
const adminActor = () => reviewActorOf({ tenantId, userId: adminId, grants: [{ scopes: [...SYSTEM_ROLES.admin!.scopes], scopeType: 'tenant', scopeId: null }] })
const ctxOf = (key: string) => ({ tenantId, actorId: people[key]! })
const stem = (text: string) => [{ id: 'b1', type: 'text' as const, html: `<p>${text}</p>` }]

async function row(itemId: string) {
  return (await admin`select * from review_queue_items where id = ${itemId}`)[0]!
}
async function link(delegationId: string) {
  return (await admin`select * from review_delegations where id = ${delegationId}`)[0]!
}

/** Работа на проверку от нашего учня — через единственную точку постановки. */
async function newItem(title: string, opts: { submittedAt?: Date, slaHours?: number, userId?: string } = {}): Promise<string> {
  const sourceId = (await admin`select gen_random_uuid() as id`)[0]!.id as string
  return withTenant(tenantId, adminId, tx => enqueueReview(tx, {
    tenantId,
    taskType: 'offline_confirm',
    sourceId,
    userId: opts.userId ?? people.learner!,
    taskTitle: `PR19 ${title}`,
    submittedAt: opts.submittedAt,
    slaHours: opts.slaHours,
  }))
}

/** Назначить работу проверяющему руками руководителя — «Дано роботу призначено наставнику А». */
async function assignTo(itemId: string, key: string) {
  const r = await reassignItem(actor('m'), itemId, { toUserId: people[key]!, reason: 'Призначення для перевірки' })
  expect(r.ok, `не удалось назначить ${key}: ${JSON.stringify(r)}`).toBe(true)
}

const mine = async (key: string, tab: 'mine' | 'delegated_in' | 'delegated_out' | 'done' = 'mine') =>
  (await listReviewQueue(ctxOf(key), { tab, taskType: 'offline_confirm', overdue: false, limit: 200 })).items

const inH = (h: number, from = Date.now()) => new Date(from + h * H).toISOString()

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  const [loc] = await admin`select id, manager_id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`
  lazareva = loc!.id as string
  const ours = (await admin`select id from users where tenant_id = ${tenantId} and phone like '+38067919000%'`).map(r => r.id as string)
  prevManager = ours.includes(loc!.manager_id as string) ? null : (loc!.manager_id as string | null) ?? null
  positionId = (await admin`select id from positions where tenant_id = ${tenantId} and code = 'cook-hot'`)[0]!.id as string
  // Остатки прошлого прогона: работы наших людей и правила этого файла.
  await cleanup()
  for (const [key, name, phone, role] of PEOPLE) {
    const [u] = await admin`
      insert into users (tenant_id, kind, full_name, phone, status)
      values (${tenantId}, 'employee', ${name}, ${phone}, 'active')
      on conflict (tenant_id, phone) do update set full_name = excluded.full_name, status = 'active', is_blocked = false
      returning id`
    people[key] = u!.id as string
    await admin`insert into user_placements (tenant_id, user_id, location_id, position_id) values (${tenantId}, ${u!.id}, ${lazareva}, ${positionId})`
    if (role) {
      await admin`
        insert into user_roles (tenant_id, user_id, role_id, scope_type, scope_id)
        values (${tenantId}, ${u!.id}, (select id from roles where tenant_id = ${tenantId} and code = ${role}), 'location', ${lazareva})`
    }
  }
  // Руководитель области — адресат нарушения срока и эскалации (`37` §7.19).
  await admin`update locations set manager_id = ${people.m!} where id = ${lazareva}`
})

async function cleanup() {
  const ids = (await admin`select id from users where tenant_id = ${tenantId} and phone like '+38067919000%'`).map(r => r.id as string)
  await admin`delete from review_routing_rules where tenant_id = ${tenantId} and name_uk like 'PR19 %'`
  if (ids.length) {
    // Руководитель точки из этого файла не должен пережить файл (прошлый прогон мог упасть).
    await admin`update locations set manager_id = null where manager_id in ${admin(ids)}`
    await admin`delete from review_queue_items where user_id in ${admin(ids)}`
    await admin`delete from workshop_comments where submission_id in (select id from workshop_submissions where user_id in ${admin(ids)})`
    await admin`delete from workshop_submissions where user_id in ${admin(ids)}`
    await admin`delete from review_delegations where from_user_id in ${admin(ids)} or to_user_id in ${admin(ids)}`
    await admin`delete from reviewer_absences where user_id in ${admin(ids)}`
    await admin`delete from reviewer_capacity where user_id in ${admin(ids)}`
    await admin`delete from reviewer_stats_daily where reviewer_id in ${admin(ids)}`
    await admin`delete from notifications where user_id in ${admin(ids)}`
    await admin`delete from audit_log where actor_id in ${admin(ids)}`
    await admin`delete from user_roles where user_id in ${admin(ids)}`
    await admin`delete from user_placements where user_id in ${admin(ids)}`
    await admin`delete from users where id in ${admin(ids)}`
  }
  await admin`delete from notifications where tenant_id = ${tenantId} and code like 'review\\_%' and payload->>'task' like 'PR19 %'`
}

afterAll(async () => {
  await admin`update locations set manager_id = ${prevManager} where id = ${lazareva}`
  await cleanup()
  if (workshopIds.length) await admin`delete from workshops where id in ${admin(workshopIds)}`
  await admin.end()
})

// ── Миграция: шесть таблиц, два ключа-развязки, пять состояний ──────────────────────────────

describe('миграция PR-19', () => {
  it('шесть тенантных таблиц под RLS enable + force с политикой using / with check', async () => {
    const rows = await admin`
      select c.relname, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
             p.polqual is not null as has_using, p.polwithcheck is not null as has_check
        from pg_class c
        left join pg_policy p on p.polrelid = c.oid and p.polname = 'tenant_isolation'
       where c.relname in ('review_delegations', 'review_routing_rules', 'reviewer_capacity', 'reviewer_absences', 'review_sla_events', 'reviewer_stats_daily')`
    expect(rows.length).toBe(6)
    for (const r of rows) expect([r.relname, r.enabled, r.forced, r.has_using, r.has_check]).toEqual([r.relname, true, true, true, true])
  })

  it('оба отложенных ключа очереди стоят по именам В-13 и не каскадные', async () => {
    const fks = await admin`
      select conname, pg_get_constraintdef(oid) as def from pg_constraint
       where conname in ('rqi_delegation_id_fk', 'rqi_assigned_by_rule_id_fk')`
    expect(fks.map(f => f.conname).sort()).toEqual(['rqi_assigned_by_rule_id_fk', 'rqi_delegation_id_fk'])
    for (const f of fks) expect(f.def).toContain('ON DELETE SET NULL')
  })

  it('два активных звена одного уровня цепочки невозможны, разных уровней — возможны (Р-19.3)', async () => {
    const itemId = await newItem('уникальність ланок')
    const due = inH(24)
    await admin`insert into review_delegations (tenant_id, queue_item_id, from_user_id, to_user_id, depth, reason_code, due_at)
                values (${tenantId}, ${itemId}, ${people.a!}, ${people.b!}, 1, 'workload', ${due})`
    await expect(admin`insert into review_delegations (tenant_id, queue_item_id, from_user_id, to_user_id, depth, reason_code, due_at)
                values (${tenantId}, ${itemId}, ${people.a!}, ${people.c!}, 1, 'workload', ${due})`).rejects.toThrow()
    await admin`insert into review_delegations (tenant_id, queue_item_id, from_user_id, to_user_id, depth, reason_code, due_at)
                values (${tenantId}, ${itemId}, ${people.b!}, ${people.c!}, 2, 'workload', ${due})`
    await admin`delete from review_delegations where queue_item_id = ${itemId}`
  })
})

// ── Критерии 1 и 2: передача ответственности и цепочка ──────────────────────────────────────

describe('37 §13 критерии 1 и 2: делегирование А→Б→В', () => {
  let itemId: string
  let slaDueAt: Date
  let ab: string

  it('к. 1: работа ушла из «Мої» у А, пришла в «Мої» у Б, у А — в «Делеговані мною»; глубина 1, первый — А', async () => {
    itemId = await newItem('критерій 1')
    await assignTo(itemId, 'a')
    slaDueAt = (await row(itemId)).sla_due_at as Date
    expect((await mine('a')).some(i => i.id === itemId), 'до передачи работа у А').toBe(true)

    const r = await delegateItem(actor('a'), itemId, { toUserId: people.b!, reasonCode: 'workload', dueAt: inH(24), notify: true })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    ab = r.delegationId

    expect((await mine('a')).some(i => i.id === itemId), 'работа осталась в «Мої» делегировавшего').toBe(false)
    expect((await mine('b')).some(i => i.id === itemId), 'работа не пришла в «Мої» делегата').toBe(true)
    expect((await mine('b', 'delegated_in')).some(i => i.id === itemId)).toBe(true)
    const out = (await mine('a', 'delegated_out')).find(i => i.id === itemId)
    expect(out, 'нет в «Делеговані мною»').toBeDefined()
    expect(out!.myDelegation?.state).toBe('active')

    const q = await row(itemId)
    expect(q.delegation_depth).toBe(1)
    expect(q.origin_reviewer_id).toBe(people.a)
    expect(q.assigned_reviewer_id).toBe(people.b)
    expect(q.status).toBe('delegated')
    expect(q.delegation_id).toBe(ab)
    expect((q.sla_due_at as Date).getTime(), 'делегирование сдвинуло срок проверки').toBe(slaDueAt.getTime())

    const [n] = await admin`select payload from notifications where user_id = ${people.b!} and code = 'review_delegated' and ref_id = ${itemId}`
    expect(n, 'делегату не ушло review_delegated').toBeDefined()
    const [log] = await admin`select after from audit_log where action = 'review.delegate' and entity_id = ${itemId} and actor_id = ${people.a!}`
    expect(log).toBeDefined()
  })

  it('к. 2: Б передаёт В — глубина 2, первый по-прежнему А; В дальше передать не может', async () => {
    const r = await delegateItem(actor('b'), itemId, { toUserId: people.c!, reasonCode: 'expertise', dueAt: inH(20), notify: true })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const q = await row(itemId)
    expect(q.delegation_depth).toBe(2)
    expect(q.origin_reviewer_id).toBe(people.a)
    expect(q.assigned_reviewer_id).toBe(people.c)
    expect((q.sla_due_at as Date).getTime()).toBe(slaDueAt.getTime())
    // Оба звена в силе: работа у В, а А→Б продолжает идти свой срок (Р-19.3).
    expect((await admin`select count(*)::int as n from review_delegations where queue_item_id = ${itemId} and state = 'active'`)[0]!.n).toBe(2)
    expect((await mine('a', 'delegated_out')).some(i => i.id === itemId)).toBe(true)
    expect((await mine('b', 'delegated_out')).some(i => i.id === itemId)).toBe(true)

    const deeper = await delegateItem(actor('c'), itemId, { toUserId: people.d!, reasonCode: 'workload', dueAt: inH(18), notify: true })
    expect(deeper).toEqual({ ok: false, code: 'depth_exceeded' })
    expect(DELEGATE_ERRORS.depth_exceeded.slice(0, 2)).toEqual([422, 'review.delegate_depth_exceeded'])
  })

  it('счётчики табов: у делегата «Делеговані мені», у делегировавших — «Делеговані мною»', async () => {
    const b = await reviewQueueCounts(ctxOf('b'))
    const a = await reviewQueueCounts(ctxOf('a'))
    const c = await reviewQueueCounts(ctxOf('c'))
    expect(c.delegatedIn, 'у В нет переданной ему работы').toBeGreaterThanOrEqual(1)
    expect(c.mine).toBeGreaterThanOrEqual(c.delegatedIn)
    expect(a.delegatedOut).toBeGreaterThanOrEqual(1)
    expect(b.delegatedOut).toBeGreaterThanOrEqual(1)
  })

  it('цикл запрещён: работа не возвращается участнику цепочки передачей', async () => {
    const itemId2 = await newItem('цикл')
    await assignTo(itemId2, 'a')
    const r = await delegateItem(actor('a'), itemId2, { toUserId: people.b!, reasonCode: 'workload', dueAt: inH(24), notify: false })
    expect(r.ok).toBe(true)
    const back = await delegateItem(actor('b'), itemId2, { toUserId: people.a!, reasonCode: 'workload', dueAt: inH(20), notify: false })
    expect(back).toEqual({ ok: false, code: 'cycle' })
    expect(DELEGATE_ERRORS.cycle[1]).toBe('review.delegate_cycle')
  })

  it('срок делегата: не раньше +12 ч и не позже срока проверки; второе звено — не позже первого', async () => {
    const x = await newItem('терміни')
    await assignTo(x, 'a')
    expect(await delegateItem(actor('a'), x, { toUserId: people.b!, reasonCode: 'workload', dueAt: inH(11), notify: false })).toEqual({ ok: false, code: 'due_too_soon' })
    expect(await delegateItem(actor('a'), x, { toUserId: people.b!, reasonCode: 'workload', dueAt: inH(49), notify: false })).toEqual({ ok: false, code: 'due_too_late' })
    expect((await delegateItem(actor('a'), x, { toUserId: people.b!, reasonCode: 'workload', dueAt: inH(20), notify: false })).ok).toBe(true)
    // Б не может выдать В больше, чем получил сам (20 ч), хотя до срока проверки — 48 ч.
    expect(await delegateItem(actor('b'), x, { toUserId: people.c!, reasonCode: 'workload', dueAt: inH(30), notify: false })).toEqual({ ok: false, code: 'due_too_late' })
  })

  it('кому нельзя передать: без права оценки или сам проверяемый — target_forbidden; кто отключил делегирование или отсутствует — target_declines', async () => {
    const x = await newItem('адресати')
    await assignTo(x, 'a')
    const d = { reasonCode: 'workload' as const, dueAt: inH(24), notify: false }
    expect(await delegateItem(actor('a'), x, { ...d, toUserId: people.colleague! })).toEqual({ ok: false, code: 'target_forbidden' })
    expect(await delegateItem(actor('a'), x, { ...d, toUserId: people.learner! })).toEqual({ ok: false, code: 'target_forbidden' })

    expect((await updateCapacity(actor('d'), people.d!, { acceptsDelegation: false })).ok).toBe(true)
    expect(await delegateItem(actor('a'), x, { ...d, toUserId: people.d! })).toEqual({ ok: false, code: 'target_declines' })
    // Список формы отфильтрован заранее: недоступных в нём нет вовсе (`37` §6.1).
    const targets = (await delegateTargets(actor('a'), x))!.map(t => t.id)
    expect(targets).not.toContain(people.d)
    expect(targets).not.toContain(people.colleague)
    expect(targets).not.toContain(people.learner)
    expect(targets).not.toContain(people.a)
    expect(targets).toContain(people.b)
    await updateCapacity(actor('d'), people.d!, { acceptsDelegation: true })
  })

  it('чужую работу передаёт только руководитель; назначенную другому не берут в руки в обход передачи', async () => {
    const x = await newItem('чужа робота')
    await assignTo(x, 'a')
    expect(await delegateItem(actor('b'), x, { toUserId: people.c!, reasonCode: 'workload', dueAt: inH(24), notify: false })).toEqual({ ok: false, code: 'forbidden' })
    const sourceId = String((await row(x)).source_id)
    const guard = await withTenant(tenantId, people.b!, tx => claimReview(tx, { taskType: 'offline_confirm', sourceId, reviewerId: people.b! }))
    expect(guard).toEqual({ ok: false, code: 'assigned_to_other' })
  })
})

// ── Критерий 4: отзыв делегирования ─────────────────────────────────────────────────────────

describe('37 §13 критерий 4: отзыв, когда делегат уже открыл карточку', () => {
  it('А получает 409 review.delegation_in_progress; руководитель отзывает только с причиной, факт — в audit_log', async () => {
    const w = await createWorkshop({ tenantId, actorId: adminId }, {
      title: 'PR19 Практикум для відкликання', description: stem('Опис'), submissionKinds: ['text'],
      minTextLength: 5, criteria: [{ text: 'Зроблено' }], reviewerRule: 'any_mentor', slaHours: 48, status: 'published',
    })
    workshopIds.push(w.id)
    const sub = await submitWorkshop(ctxOf('learner'), w.id, { text: 'Виконав за інструкцією' })
    expect(sub.ok).toBe(true)
    if (!sub.ok) return
    const [q0] = await admin`select id, sla_due_at from review_queue_items where task_type = 'workshop' and source_id = ${sub.submissionId}`
    const itemId = q0!.id as string
    await assignTo(itemId, 'a')
    const d = await delegateItem(actor('a'), itemId, { toUserId: people.b!, reasonCode: 'workload', dueAt: inH(24), notify: true })
    expect(d.ok).toBe(true)
    if (!d.ok) return

    // А после передачи открыть работу не может — она у Б.
    expect(await claim(ctxOf('a'), sub.submissionId)).toEqual({ ok: false, code: 'assigned_to_other' })
    // Б открыл карточку.
    expect((await claim(ctxOf('b'), sub.submissionId)).ok).toBe(true)
    expect((await row(itemId)).status).toBe('in_review')

    const byAuthor = await revokeDelegation(actor('a'), d.delegationId, {})
    expect(byAuthor).toEqual({ ok: false, code: 'in_progress' })
    expect(REVOKE_ERRORS.in_progress.slice(0, 2)).toEqual([409, 'review.delegation_in_progress'])

    const noReason = await revokeDelegation(actor('m'), d.delegationId, {})
    expect(noReason).toEqual({ ok: false, code: 'reason_required' })

    const byManager = await revokeDelegation(actor('m'), d.delegationId, { reason: 'Б пішов на лікарняний посеред перевірки' })
    expect(byManager.ok, JSON.stringify(byManager)).toBe(true)
    const l = await link(d.delegationId)
    expect(l.state).toBe('revoked_by_manager')
    expect(l.revoked_by).toBe(people.m)
    expect(l.revoke_reason).toBe('Б пішов на лікарняний посеред перевірки')

    const q = await row(itemId)
    expect(q.assigned_reviewer_id, 'работа не вернулась делегировавшему').toBe(people.a)
    expect(q.status).toBe('waiting')
    expect(q.claimed_by).toBeNull()
    expect(q.delegation_depth).toBe(0)
    expect((q.sla_due_at as Date).getTime()).toBe((q0!.sla_due_at as Date).getTime())
    // Зеркало практикума не держит захват делегата (В-2).
    const [ws] = await admin`select status, reviewer_id from workshop_submissions where id = ${sub.submissionId}`
    expect(ws!.status).toBe('submitted')
    expect(ws!.reviewer_id).toBeNull()

    const [log] = await admin`select after from audit_log where action = 'review.delegation_revoke' and entity_id = ${d.delegationId} and actor_id = ${people.m!}`
    expect(log, 'отзыв руководителем не записан в audit_log').toBeDefined()
    expect((log!.after as { reason: string }).reason).toBe('Б пішов на лікарняний посеред перевірки')
    const [n] = await admin`select id from notifications where user_id = ${people.b!} and code = 'review_delegation_revoked' and ref_id = ${itemId}`
    expect(n, 'делегату не ушло review_delegation_revoked').toBeDefined()
  })

  it('пока делегат не открыл карточку, автор отзывает сам и без причины', async () => {
    const x = await newItem('відкликання автором')
    await assignTo(x, 'a')
    const d = await delegateItem(actor('a'), x, { toUserId: people.b!, reasonCode: 'workload', dueAt: inH(24), notify: false })
    if (!d.ok) throw new Error(d.code)
    const r = await revokeDelegation(actor('a'), d.delegationId, {})
    expect(r.ok).toBe(true)
    expect((await link(d.delegationId)).state).toBe('revoked_by_author')
    expect((await row(x)).assigned_reviewer_id).toBe(people.a)
    // Посторонний отозвать не может.
    const again = await delegateItem(actor('a'), x, { toUserId: people.b!, reasonCode: 'workload', dueAt: inH(24), notify: false })
    if (!again.ok) throw new Error(again.code)
    expect(await revokeDelegation(actor('c'), again.delegationId, {})).toEqual({ ok: false, code: 'forbidden' })
  })

  it('решение делегата окончательное: звено resolved, делегировавшему — review_delegation_resolved с результатом', async () => {
    const w = await createWorkshop({ tenantId, actorId: adminId }, {
      title: 'PR19 Практикум для рішення делегата', description: stem('Опис'), submissionKinds: ['text'],
      minTextLength: 5, criteria: [{ text: 'Зроблено' }], reviewerRule: 'any_mentor', slaHours: 48, status: 'published',
    })
    workshopIds.push(w.id)
    const sub = await submitWorkshop(ctxOf('learner'), w.id, { text: 'Виконав за інструкцією' })
    if (!sub.ok) throw new Error(sub.code)
    const itemId = (await admin`select id from review_queue_items where source_id = ${sub.submissionId}`)[0]!.id as string
    await assignTo(itemId, 'a')
    const d = await delegateItem(actor('a'), itemId, { toUserId: people.b!, reasonCode: 'expertise', dueAt: inH(24), notify: false })
    if (!d.ok) throw new Error(d.code)
    expect((await claim(ctxOf('b'), sub.submissionId)).ok).toBe(true)
    const criterionId = (await admin`select criteria_snapshot from workshop_submissions where id = ${sub.submissionId}`)[0]!.criteria_snapshot[0].id
    const g = await grade(ctxOf('b'), sub.submissionId, { decision: 'accepted', criteriaResults: [{ criterionId, passed: true }] })
    expect(g.ok, JSON.stringify(g)).toBe(true)

    expect((await link(d.delegationId)).state).toBe('resolved')
    const q = await row(itemId)
    expect(q.status).toBe('done')
    expect(q.assigned_reviewer_id).toBe(people.b)
    const [n] = await admin`select payload from notifications where user_id = ${people.a!} and code = 'review_delegation_resolved' and ref_id = ${itemId}`
    expect(n, 'делегировавшему не ушло review_delegation_resolved').toBeDefined()
    expect((n!.payload as { decision: string }).decision).toBe('зараховано')
    // Результат виден на «Делеговані мною» (`37` §7.4).
    const out = (await listReviewQueue(ctxOf('a'), { tab: 'delegated_out', taskType: 'workshop', overdue: false, limit: 200 })).items.find(i => i.id === itemId)
    expect(out?.status).toBe('done')
    expect(out?.myDelegation?.state).toBe('resolved')
  })
})

// ── Критерий 3: возврат по сроку делегата ───────────────────────────────────────────────────

describe('37 §13 критерий 3: делегат не уложился', () => {
  it('работа вернулась к А со звеном revoked_sla, уведомлены оба, срок проверки не сдвинулся', async () => {
    const itemId = await newItem('критерій 3')
    await assignTo(itemId, 'a')
    const before = (await row(itemId)).sla_due_at as Date
    const d = await delegateItem(actor('a'), itemId, { toUserId: people.b!, reasonCode: 'workload', dueAt: inH(24), notify: true })
    if (!d.ok) throw new Error(d.code)

    // Через сутки и час — задача review.delegation_expire.
    const n = await expireDelegations(tenantId, new Date(Date.now() + 25 * H))
    expect(n).toBeGreaterThanOrEqual(1)

    const l = await link(d.delegationId)
    expect(l.state).toBe('revoked_sla')
    const q = await row(itemId)
    expect(q.assigned_reviewer_id).toBe(people.a)
    expect(q.delegation_depth).toBe(0)
    expect(q.delegation_id).toBeNull()
    expect(q.status).toBe('waiting')
    expect((q.sla_due_at as Date).getTime(), 'возврат сдвинул срок проверки').toBe(before.getTime())
    for (const key of ['a', 'b']) {
      const [msg] = await admin`select id from notifications where user_id = ${people[key]!} and code = 'review_delegation_expired' and ref_id = ${itemId}`
      expect(msg, `review_delegation_expired не ушло ${key}`).toBeDefined()
    }
    const [ev] = await admin`select reviewer_id, target_id from review_sla_events where queue_item_id = ${itemId} and event = 'delegation_expired'`
    expect(ev?.reviewer_id).toBe(people.b)
    expect(ev?.target_id).toBe(people.a)
  })

  it('в цепочке А→Б→В истекает только звено Б→В: работа у Б, глубина 1, звено А→Б в силе', async () => {
    const itemId = await newItem('ланцюжок за терміном')
    await assignTo(itemId, 'a')
    const ab = await delegateItem(actor('a'), itemId, { toUserId: people.b!, reasonCode: 'workload', dueAt: inH(40), notify: false })
    const bc = await delegateItem(actor('b'), itemId, { toUserId: people.c!, reasonCode: 'workload', dueAt: inH(13), notify: false })
    if (!ab.ok || !bc.ok) throw new Error('chain')
    await expireDelegations(tenantId, new Date(Date.now() + 14 * H))
    expect((await link(bc.delegationId)).state).toBe('revoked_sla')
    expect((await link(ab.delegationId)).state).toBe('active')
    const q = await row(itemId)
    expect(q.assigned_reviewer_id).toBe(people.b)
    expect(q.delegation_depth).toBe(1)
    expect(q.delegation_id).toBe(ab.delegationId)
    expect(q.status).toBe('delegated')
    expect(q.origin_reviewer_id).toBe(people.a)
  })

  it('открытую прямо сейчас карточку возврат не вырывает из рук — до протухания захвата', async () => {
    const itemId = await newItem('живий захоплення')
    await assignTo(itemId, 'a')
    const d = await delegateItem(actor('a'), itemId, { toUserId: people.b!, reasonCode: 'workload', dueAt: inH(24), notify: false })
    if (!d.ok) throw new Error(d.code)
    const now = new Date(Date.now() + 25 * H)
    await admin`update review_queue_items set status = 'in_review', claimed_by = ${people.b!}, claimed_at = ${new Date(now.getTime() - 5 * 60_000)} where id = ${itemId}`
    await expireDelegations(tenantId, now)
    expect((await link(d.delegationId)).state).toBe('active')
    await admin`update review_queue_items set claimed_at = ${new Date(now.getTime() - 31 * 60_000)} where id = ${itemId}`
    await expireDelegations(tenantId, now)
    expect((await link(d.delegationId)).state).toBe('revoked_sla')
    expect((await row(itemId)).claimed_by).toBeNull()
  })
})

// ── Переназначение и массовая передача ─────────────────────────────────────────────────────

describe('переназначение и «Делегувати обрані» (`37` §5.1, §10)', () => {
  it('руководитель переназначает без цепочки: звенья закрыты его причиной, срок не сдвинут', async () => {
    const itemId = await newItem('переназначення')
    await assignTo(itemId, 'a')
    const before = (await row(itemId)).sla_due_at as Date
    const d = await delegateItem(actor('a'), itemId, { toUserId: people.b!, reasonCode: 'workload', dueAt: inH(24), notify: false })
    if (!d.ok) throw new Error(d.code)
    expect((await reassignItem(actor('b'), itemId, { toUserId: people.c!, reason: 'Хочу' })).ok, 'наставник переназначил без права').toBe(false)
    const r = await reassignItem(actor('m'), itemId, { toUserId: people.c!, reason: 'Б перевантажений' })
    expect(r.ok).toBe(true)
    expect((await link(d.delegationId)).state).toBe('revoked_by_manager')
    const q = await row(itemId)
    expect([q.assigned_reviewer_id, q.delegation_id, q.delegation_depth, q.assigned_by_rule_id]).toEqual([people.c, null, 0, null])
    expect((q.sla_due_at as Date).getTime()).toBe(before.getTime())
  })

  it('больше 25 за раз — bulk_limit; отказ по одной работе не откатывает остальные', async () => {
    const ids = Array.from({ length: 26 }, () => '00000000-0000-4000-8000-000000000000')
    const tooMany = await bulkDelegate(actor('a'), { itemIds: ids.map((_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`), toUserId: people.b!, reasonCode: 'workload', dueAt: inH(24), notify: false })
    expect(tooMany).toEqual({ ok: false, code: 'bulk_limit' })

    const mineA = [await newItem('масово 1'), await newItem('масово 2')]
    for (const id of mineA) await assignTo(id, 'a')
    const foreign = await newItem('масово чужа')
    await assignTo(foreign, 'c')
    const r = await bulkDelegate(actor('a'), { itemIds: [...mineA, foreign], toUserId: people.b!, reasonCode: 'workload', dueAt: inH(24), notify: false })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.delegated.sort()).toEqual([...mineA].sort())
    expect(r.failed).toEqual([{ id: foreign, code: 'forbidden' }])
    for (const id of mineA) expect((await row(id)).assigned_reviewer_id).toBe(people.b)
  })
})

// ── Карточка проверки: кто её видит ─────────────────────────────────────────────────────────

describe('карточка проверки `GET /review/items/:id` — видимость', () => {
  it('назначенному и цепочке — видна; постороннему проверяющему — 404; руководителю области — видна', async () => {
    const itemId = await newItem('видимість картки')
    await assignTo(itemId, 'a')
    const d = await delegateItem(actor('a'), itemId, { toUserId: people.b!, reasonCode: 'workload', dueAt: inH(24), notify: false })
    if (!d.ok) throw new Error(d.code)
    expect(await getReviewItem(actor('b'), itemId)).not.toBeNull()
    const byA = await getReviewItem(actor('a'), itemId)
    expect(byA?.can.revoke, 'автор не видит кнопку отзыва').toBe(d.delegationId)
    expect(await getReviewItem(actor('c'), itemId), 'посторонний видит чужую назначенную работу').toBeNull()
    expect((await getReviewItem(actor('m'), itemId))?.can.reassign).toBe(true)
    // Своя работа не видна никогда (§7.7).
    expect(await getReviewItem(reviewActorOf({ tenantId, userId: people.learner!, grants: [{ scopes: ['review.queue'], scopeType: 'tenant', scopeId: null }] }), itemId)).toBeNull()
  })
})

// ── Критерий 12: круговое распределение с отсутствующим ────────────────────────────────────

describe('37 §13 критерий 12: round_robin на трёх, один в отпуске', () => {
  it('шесть работ распределены 3/3 между присутствующими, отсутствующему — ни одной', async () => {
    const rule = await createRoutingRule(adminActor(), {
      nameUk: 'PR19 Коло трьох', priority: 1, matchScope: { locationIds: [lazareva] }, matchSubjectKind: null,
      matchTaskTypes: ['offline_confirm'], strategy: 'round_robin', reviewerIds: [people.a!, people.b!, people.c!],
      fallbackUserId: null, slaHoursOverride: null, isActive: true,
    })
    expect(rule.ok, JSON.stringify(rule)).toBe(true)
    if (!rule.ok) return
    ruleIds.push(rule.id)
    const today = new Date().toISOString().slice(0, 10)
    const until = new Date(Date.now() + 7 * 24 * H).toISOString().slice(0, 10)
    const abs = await createAbsence(actor('m'), { userId: people.c!, kind: 'vacation', startsOn: today, endsOn: until, moveOpenItems: true })
    expect(abs.ok, JSON.stringify(abs)).toBe(true)

    const items: string[] = []
    for (let i = 0; i < 6; i++) items.push(await newItem(`коло ${i}`))
    const assigned = await admin`select assigned_reviewer_id as r, assigned_by_rule_id as rule from review_queue_items where id in ${admin(items)}`
    const count = (key: string) => assigned.filter(x => x.r === people[key]).length
    expect([count('a'), count('b'), count('c')]).toEqual([3, 3, 0])
    expect(assigned.every(x => x.rule === rule.id), 'назначение не помечено правилом').toBe(true)
    const [ev] = await admin`select details from review_sla_events where queue_item_id = ${items[0]!} and event = 'assigned'`
    expect((ev!.details as { strategy: string }).strategy).toBe('round_robin')

    await deleteRoutingRule(adminActor(), rule.id)
    // Удаление правила не уносит работу из очереди: ключ set null (В-13).
    const after = await admin`select assigned_reviewer_id, assigned_by_rule_id from review_queue_items where id in ${admin(items)}`
    expect(after.length).toBe(6)
    expect(after.every(x => x.assigned_by_rule_id === null && x.assigned_reviewer_id !== null)).toBe(true)
    await admin`delete from reviewer_absences where user_id = ${people.c!}`
  })

  it('правило правится целиком, список показывает и выключенные; чужое правило руководитель не трогает', async () => {
    const input = {
      nameUk: 'PR19 Правка', priority: 50, matchScope: { locationIds: [lazareva] }, matchSubjectKind: null,
      matchTaskTypes: ['workshop' as const], strategy: 'least_loaded' as const, reviewerIds: [], fallbackUserId: null,
      slaHoursOverride: null, isActive: true,
    }
    const created = await createRoutingRule(actor('m'), input)
    expect(created.ok, JSON.stringify(created)).toBe(true)
    if (!created.ok) return
    ruleIds.push(created.id)
    expect((await updateRoutingRule(actor('m'), created.id, { ...input, isActive: false, priority: 60 })).ok).toBe(true)
    const listed = (await listRoutingRules(actor('m'))).find(r => r.id === created.id)
    expect([listed?.isActive, listed?.priority]).toEqual([false, 60])
    // Правило на всю сеть (его завёл администратор) — вне области руководителя точки.
    const network = await createRoutingRule(adminActor(), { ...input, nameUk: 'PR19 Мережа', matchScope: {} })
    if (!network.ok) throw new Error(network.code)
    ruleIds.push(network.id)
    expect(await updateRoutingRule(actor('m'), network.id, { ...input, matchScope: {} })).toEqual({ ok: false, code: 'forbidden' })
    expect(await deleteRoutingRule(actor('m'), network.id)).toEqual({ ok: false, code: 'forbidden' })
    for (const id of [created.id, network.id]) expect((await deleteRoutingRule(adminActor(), id)).ok).toBe(true)
  })

  it('руководитель точки правит только правила своей области: правило на всю сеть — routing.scope_empty', async () => {
    const r = await createRoutingRule(actor('m'), {
      nameUk: 'PR19 На всю мережу', priority: 5, matchScope: {}, matchSubjectKind: null, matchTaskTypes: [],
      strategy: 'least_loaded', reviewerIds: [], fallbackUserId: null, slaHoursOverride: null, isActive: true,
    })
    expect(r).toEqual({ ok: false, code: 'scope_empty' })
  })

  it('кандидатов ноль — запасной адресат правила; правил нет — работа в общем пуле', async () => {
    const rule = await createRoutingRule(adminActor(), {
      nameUk: 'PR19 Запасний', priority: 1, matchScope: { locationIds: [lazareva] }, matchSubjectKind: null,
      matchTaskTypes: ['offline_confirm'], strategy: 'specific_list', reviewerIds: [people.learner!],
      fallbackUserId: people.d!, slaHoursOverride: 24, isActive: true,
    })
    if (!rule.ok) throw new Error(rule.code)
    ruleIds.push(rule.id)
    const x = await newItem('запасний адресат')
    const q = await row(x)
    // Единственный в списке — сам проверяемый: исключён (§7.7), работа ушла запасному.
    expect(q.assigned_reviewer_id).toBe(people.d)
    expect(q.sla_hours, 'снимок SLA правила не применён при постановке').toBe(24)
    await deleteRoutingRule(adminActor(), rule.id)

    const pool = await newItem('без правил')
    expect((await row(pool)).assigned_reviewer_id).toBeNull()
    // Суточная перебалансировка: работа старше суток без проверяющего — правилами; правил нет — пул.
    await admin`update review_queue_items set submitted_at = now() - interval '25 hours' where id = ${pool}`
    expect(await rebalanceTenant(tenantId)).toBeGreaterThanOrEqual(0)
    expect((await row(pool)).assigned_reviewer_id).toBeNull()
  })
})

// ── Критерий 13: отпуск с замещением ───────────────────────────────────────────────────────

describe('37 §13 критерий 13: отпуск с двенадцатью открытыми работами и замещением', () => {
  it('в день начала waiting и delegated переехали на замещающего, in_review осталась до освобождения карточки', async () => {
    const waiting: string[] = []
    for (let i = 0; i < 10; i++) {
      const id = await newItem(`відпустка ${i}`)
      await assignTo(id, 'a')
      waiting.push(id)
    }
    // Одна работа делегирована А коллегой Г.
    const delegated = await newItem('відпустка делегована')
    await assignTo(delegated, 'd')
    const dg = await delegateItem(actor('d'), delegated, { toUserId: people.a!, reasonCode: 'workload', dueAt: inH(30), notify: false })
    if (!dg.ok) throw new Error(dg.code)
    // Одну А держит открытой прямо сейчас.
    const open = await newItem('відпустка відкрита')
    await assignTo(open, 'a')
    const g = await withTenant(tenantId, people.a!, async tx => claimReview(tx, { taskType: 'offline_confirm', sourceId: String((await row(open)).source_id), reviewerId: people.a! }))
    expect(g.ok).toBe(true)
    const all = [...waiting, delegated, open]
    expect((await admin`select count(*)::int as n from review_queue_items where assigned_reviewer_id = ${people.a!} and id in ${admin(all)}`)[0]!.n).toBe(12)
    const dues = new Map((await admin`select id, sla_due_at from review_queue_items where id in ${admin(all)}`).map(r => [r.id as string, (r.sla_due_at as Date).getTime()]))

    const tomorrow = new Date(Date.now() + 24 * H).toISOString().slice(0, 10)
    const until = new Date(Date.now() + 14 * 24 * H).toISOString().slice(0, 10)
    const created = await createAbsence(actor('a'), { userId: people.a!, kind: 'vacation', startsOn: tomorrow, endsOn: until, substituteId: people.s!, moveOpenItems: true })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    if (!created.ok) return
    expect(created.movedCount, 'отпуск ещё не начался, а очередь уже переехала').toBe(0)

    // Настал starts_on — задача review.absence_apply. У А могли остаться открытые работы из
    // сценариев выше — они переезжают вместе с этими двенадцатью, поэтому «не меньше 11».
    const moved = await applyAbsences(tenantId, { day: tomorrow })
    expect(moved).toBeGreaterThanOrEqual(11)
    const rows = await admin`select id, assigned_reviewer_id, status, delegation_depth, sla_due_at from review_queue_items where id in ${admin(all)}`
    const by = new Map(rows.map(r => [r.id as string, r]))
    for (const id of waiting) expect(by.get(id)!.assigned_reviewer_id, 'waiting не переехала').toBe(people.s)
    expect(by.get(delegated)!.assigned_reviewer_id, 'delegated не переехала').toBe(people.s)
    expect(by.get(delegated)!.delegation_depth).toBe(2)
    expect(by.get(open)!.assigned_reviewer_id, 'in_review вырвали из рук').toBe(people.a)
    expect(by.get(open)!.status).toBe('in_review')
    for (const r of rows) expect((r.sla_due_at as Date).getTime(), 'переброс сдвинул срок').toBe(dues.get(r.id as string))
    const [n] = await admin`select payload from notifications where user_id = ${people.s!} and code = 'review_queue_moved' order by created_at desc limit 1`
    expect((n!.payload as { n: number }).n, 'замещающему не сказали, сколько работ пришло').toBe(moved)
    expect((await admin`select count(*)::int as n from review_queue_items where assigned_reviewer_id = ${people.a!} and status <> 'done'`)[0]!.n).toBe(1)

    // Карточка освободилась (30 минут бездействия) — следующий прогон забирает и её.
    await admin`update review_queue_items set claimed_at = now() - interval '31 minutes' where id = ${open}`
    expect(await applyAbsences(tenantId, { day: tomorrow })).toBe(1)
    expect((await row(open)).assigned_reviewer_id).toBe(people.s)
    // Отсутствующий выпадает из списка делегатов на весь период.
    await admin`delete from reviewer_absences where user_id = ${people.a!}`
  })

  it('увольнение делегата возвращает переданные ему работы делегировавшим', async () => {
    const x = await newItem('звільнення делегата')
    await assignTo(x, 'b')
    const d = await delegateItem(actor('b'), x, { toUserId: people.d!, reasonCode: 'workload', dueAt: inH(24), notify: false })
    if (!d.ok) throw new Error(d.code)
    const today = new Date().toISOString().slice(0, 10)
    const r = await createAbsence(actor('m'), { userId: people.d!, kind: 'dismissal', startsOn: today, substituteId: people.s!, moveOpenItems: false })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect((await link(d.delegationId)).state).toBe('revoked_sla')
    expect((await row(x)).assigned_reviewer_id).toBe(people.b)
    await admin`delete from reviewer_absences where user_id = ${people.d!}`
  })

  it('чужое отсутствие отмечает только тот, кто видит нагрузку; конец раньше начала и заместитель-сам — отказ', async () => {
    const today = new Date().toISOString().slice(0, 10)
    expect(await createAbsence(actor('a'), { userId: people.b!, kind: 'sick', startsOn: today, moveOpenItems: true })).toEqual({ ok: false, code: 'forbidden' })
    expect(await createAbsence(actor('a'), { userId: people.a!, kind: 'sick', startsOn: '2026-10-10', endsOn: '2026-10-01', moveOpenItems: true })).toEqual({ ok: false, code: 'range_invalid' })
    expect(await createAbsence(actor('a'), { userId: people.a!, kind: 'sick', startsOn: today, substituteId: people.a!, moveOpenItems: true })).toEqual({ ok: false, code: 'self_substitute' })
  })
})

// ── Критерий 14: пороги срока проверки ─────────────────────────────────────────────────────

describe('37 §13 критерий 14: SLA 48 ч — 24-й, 48-й и 72-й час', () => {
  it('предупреждение проверяющему, нарушение руководителю с коралловой строкой, эскалация видна обоим', async () => {
    const t0 = new Date(Date.now() - 73 * H)
    const itemId = await newItem('критерій 14', { submittedAt: t0, slaHours: 48 })
    await assignTo(itemId, 'a')
    const due = (await row(itemId)).sla_due_at as Date
    expect(due.getTime()).toBe(t0.getTime() + 48 * H)

    await reviewSlaScan(tenantId, new Date(t0.getTime() + 24 * H))
    let q = await row(itemId)
    expect(q.sla_warned_at, '24-й час: нет отметки предупреждения').not.toBeNull()
    expect(q.sla_breached_at).toBeNull()
    expect((await admin`select id from notifications where user_id = ${people.a!} and code = 'review_sla_warning' and ref_id = ${itemId}`).length).toBe(1)

    await reviewSlaScan(tenantId, new Date(t0.getTime() + 48 * H))
    q = await row(itemId)
    expect(q.sla_breached_at, '48-й час: нет отметки нарушения').not.toBeNull()
    expect(q.status).toBe('waiting')
    expect((await admin`select id from notifications where user_id = ${people.m!} and code = 'review_sla_breach' and ref_id = ${itemId}`).length).toBe(1)
    const coral = (await mine('a')).find(i => i.id === itemId)
    expect(coral?.overdue, 'строка не коралловая').toBe(true)
    expect(coral?.slaBreachedAt).not.toBeNull()

    await reviewSlaScan(tenantId, new Date(t0.getTime() + 72 * H))
    q = await row(itemId)
    expect(q.status).toBe('escalated')
    expect(q.escalated_to_id).toBe(people.m)
    expect(q.assigned_reviewer_id, 'эскалация отняла работу у проверяющего').toBe(people.a)
    expect((await admin`select id from notifications where user_id = ${people.m!} and code = 'review_escalated' and ref_id = ${itemId}`).length).toBe(1)
    expect((await mine('a')).some(i => i.id === itemId), 'проверяющий не видит эскалированную работу').toBe(true)
    expect((await mine('m')).some(i => i.id === itemId), 'руководитель не видит эскалированную работу').toBe(true)
    expect((q.sla_due_at as Date).getTime()).toBe(due.getTime())
    const events = (await admin`select event from review_sla_events where queue_item_id = ${itemId} order by created_at`).map(r => r.event)
    expect(events).toEqual(expect.arrayContaining(['warned', 'breached', 'escalated']))

    // Повторный прогон ничего не дублирует.
    await reviewSlaScan(tenantId, new Date(t0.getTime() + 80 * H))
    expect((await admin`select count(*)::int as n from review_sla_events where queue_item_id = ${itemId} and event = 'escalated'`)[0]!.n).toBe(1)

    // Руководитель, на которого эскалировано, берёт работу в руки, отпускает — она снова escalated.
    const g = await withTenant(tenantId, people.m!, async tx => claimReview(tx, { taskType: 'offline_confirm', sourceId: String(q.source_id), reviewerId: people.m! }))
    expect(g.ok).toBe(true)
  })

  it('руководитель сам проверяющий — эскалация уходит администратору тенанта (фолбэк PR-19)', async () => {
    const t0 = new Date(Date.now() - 73 * H)
    const itemId = await newItem('ескалація на адміна', { submittedAt: t0, slaHours: 48 })
    await reassignItem(adminActor(), itemId, { toUserId: people.m!, reason: 'Керівник перевіряє сам' })
    await reviewSlaScan(tenantId, new Date(t0.getTime() + 72 * H))
    const q = await row(itemId)
    expect(q.status).toBe('escalated')
    expect(q.escalated_to_id, 'эскалация ушла самому проверяющему').toBe(adminId)
    const [ev] = await admin`select details from review_sla_events where queue_item_id = ${itemId} and event = 'escalated'`
    expect((ev!.details as { target: string }).target).toBe('admin')
  })
})

// ── Нагрузка и статистика ──────────────────────────────────────────────────────────────────

describe('экран нагрузки и суточная статистика (`37` §5.3, §9.2)', () => {
  it('руководитель видит проверяющих своей точки с открытыми работами и лимитом', async () => {
    const rows = await listWorkload(actor('m'), {})
    const a = rows.find(r => r.userId === people.a)
    expect(a, 'наставника точки нет на экране нагрузки').toBeDefined()
    expect(a!.max).toBe(20)
    expect(rows.some(r => r.userId === people.colleague)).toBe(false)
  })

  it('review.stats_rollup считает передачи за сутки по журналу, повторный прогон не дублирует', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const n = await reviewStatsRollup(tenantId, today)
    expect(n).toBeGreaterThan(0)
    await reviewStatsRollup(tenantId, today)
    const [a] = await admin`select delegated_out from reviewer_stats_daily where reviewer_id = ${people.a!} and day = ${today}::date`
    expect(a!.delegated_out).toBeGreaterThan(0)
    expect((await admin`select count(*)::int as n from reviewer_stats_daily where reviewer_id = ${people.a!} and day = ${today}::date`)[0]!.n).toBe(1)
  })
})
