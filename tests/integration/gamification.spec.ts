import 'dotenv/config'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Access } from '../../server/services/access'

/**
 * Геймификация (docs/02 §2.10, docs/21 §3.7, §14.9, Г-21.1; docs/15 §14.3; docs/33 D-069):
 * книга баллов и бонусов — единственный источник баланса, начисление за выполненное задание
 * идемпотентно, правила тенанта перекрываются назначением, магазин держит остаток и лимит
 * транзакционно (гонка за последнюю единицу), резерв истекает задачей, права — по области.
 */
const ledgerSvc = await import('../../server/services/pointsLedger')
const rewards = await import('../../server/services/rewards')
const shop = await import('../../server/services/shop')
const bonuses = await import('../../server/services/bonuses')
const { completeTask } = await import('../../server/services/taskCompletion')
const { studyHistory } = await import('../../server/services/reportsExtra')
const { withTenant } = await import('../../server/utils/withTenant')
const { shopReserveExpireTenant } = await import('../../server/jobs/shopReserveExpire')
const { DEFAULT_TASK_REWARDS, SHOP_RESERVE_DAYS } = await import('../../shared/domain/gamification')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const stamp = Date.now()

let tenantId: string
let otherTenantId: string
let adminId: string
let lazarevaId: string
let segedskaId: string
let positionId: string
let settingsBefore: unknown
const userIds: string[] = []
const assignmentIds: string[] = []
const itemIds: string[] = []
const categoryIds: string[] = []
const courseIds: string[] = []

const ctx = (actorId: string) => ({ tenantId, actorId })

/** Доступ «как у роли»: скоупы на весь тенант или на точку (docs/01 §1.1). */
function access(userId: string, scopes: string[], locationId?: string): Access {
  return { userId, tenantId, grants: [{ scopes, scopeType: locationId ? 'location' : 'tenant', scopeId: locationId ?? null }], activeRole: null, roles: [] }
}

async function makePerson(name: string, locationId = lazarevaId, kind: 'employee' | 'candidate' = 'employee') {
  const phone = `+38093${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = kind === 'candidate'
    ? await admin`insert into users (tenant_id, phone, full_name, status, kind, candidate_state, source) values (${tenantId}, ${phone}, ${name}, 'active', 'candidate', 'active', 'manual') returning id`
    : await admin`insert into users (tenant_id, phone, full_name, status) values (${tenantId}, ${phone}, ${name}, 'active') returning id`
  userIds.push(u!.id as string)
  if (kind === 'employee') await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${locationId}, ${positionId}, true)`
  return u!.id as string
}

async function makeAssignment(subjectType: string, params: Record<string, unknown> = {}, subjectId: string = crypto.randomUUID()) {
  const [a] = await admin`insert into assignments (tenant_id, title, subject_type, subject_id, audience, params, status)
    values (${tenantId}, ${`Завдання ${subjectType} ${stamp}-${assignmentIds.length}`}, ${subjectType}, ${subjectId}, '{"rules":[]}', ${admin.json(params as never)}, 'active') returning id`
  assignmentIds.push(a!.id as string)
  return { id: a!.id as string, subjectId }
}

async function ledgerOf(userId: string) {
  return admin`select currency, delta, balance_after, event, ref_id, title, comment from points_ledger where user_id = ${userId} order by id`
}

async function grant(userId: string, delta: number) {
  const r = await bonuses.adjustBonuses(ctx(adminId), access(adminId, ['bonus.grant', 'shop.manage']), { userId, delta, comment: 'Тестове нарахування' })
  if (!r.ok) throw new Error(`grant: ${r.code}`)
  return r.balance
}

async function makeItem(input: Partial<Parameters<typeof shop.createShopItem>[1]> = {}) {
  const r = await shop.createShopItem(ctx(adminId), { title: `Подарунок ${stamp}-${itemIds.length}`, priceBonuses: 10, isActive: true, ...input })
  if (!r.ok) throw new Error(`item: ${r.code}`)
  itemIds.push(r.id)
  return r.id
}

beforeAll(async () => {
  const [t] = await admin`select id, settings from tenants where slug = 'kappi'`
  tenantId = t!.id as string
  settingsBefore = t!.settings
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  segedskaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Сегедська'`)[0]!.id as string
  positionId = (await admin`select id from positions where tenant_id = ${tenantId} order by name limit 1`)[0]!.id as string
  const [o] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = o!.id as string
})

afterAll(async () => {
  await admin`update tenants set settings = ${admin.json((settingsBefore ?? {}) as never)} where id = ${tenantId}`
  if (userIds.length) {
    await admin`delete from shop_orders where user_id in ${admin(userIds)}`
    await admin`delete from points_ledger where user_id in ${admin(userIds)}`
    await admin`delete from notifications where user_id in ${admin(userIds)}`
    await admin`delete from task_status_log where user_id in ${admin(userIds)}`
  }
  if (itemIds.length) {
    await admin`delete from shop_orders where item_id in ${admin(itemIds)}`
    await admin`delete from shop_items where id in ${admin(itemIds)}`
  }
  if (categoryIds.length) await admin`delete from shop_categories where id in ${admin(categoryIds)}`
  if (assignmentIds.length) await admin`delete from assignments where id in ${admin(assignmentIds)}`
  if (courseIds.length) await admin`delete from courses where id in ${admin(courseIds)}`
  if (userIds.length) {
    await admin`delete from user_placements where user_id in ${admin(userIds)}`
    await admin`delete from users where id in ${admin(userIds)}`
  }
  await admin.end()
})

describe('книга баллов и бонусов (docs/21 §14.9)', () => {
  it('баланс — последняя строка; списание ниже нуля не проводится; повтор события со ссылкой — duplicate', async () => {
    const u = await makePerson('Книга Перша')
    const ref = crypto.randomUUID()
    await withTenant(tenantId, adminId, async (tx) => {
      expect(await ledgerSvc.balanceOf(tx, u, 'bonuses')).toBe(0)
      const a = await ledgerSvc.postEntry(tx, { tenantId, userId: u, currency: 'bonuses', delta: 12, event: 'manual', comment: 'раз' })
      expect(a).toMatchObject({ ok: true, balanceAfter: 12 })
      const b = await ledgerSvc.postEntry(tx, { tenantId, userId: u, currency: 'bonuses', delta: -20, event: 'manual', comment: 'забагато' })
      expect(b).toEqual({ ok: false, code: 'insufficient', balance: 12 })
      const c = await ledgerSvc.postEntry(tx, { tenantId, userId: u, currency: 'bonuses', delta: 5, event: 'task_completed', refId: ref, title: 'Завдання' })
      expect(c).toMatchObject({ ok: true, balanceAfter: 17 })
      const d = await ledgerSvc.postEntry(tx, { tenantId, userId: u, currency: 'bonuses', delta: 5, event: 'task_completed', refId: ref, title: 'Завдання' })
      expect(d).toEqual({ ok: false, code: 'duplicate', balance: 17 })
      // Две ручные строки подряд — законны: у ручной операции ссылки нет
      expect(await ledgerSvc.postEntry(tx, { tenantId, userId: u, currency: 'bonuses', delta: 1, event: 'manual', comment: 'ще' })).toMatchObject({ ok: true, balanceAfter: 18 })
      // Валюты независимы: баллы рейтинга не видят бонусов
      expect(await ledgerSvc.balanceOf(tx, u, 'points')).toBe(0)
    })
    expect(await ledgerSvc.ledgerDrift(tenantId)).toEqual([])
  })

  it('CHECK и RLS: нулевая сумма, отрицательный остаток и событие без ссылки не записать; чужой тенант не видит строк', async () => {
    const u = await makePerson('Книга Друга')
    await expect(admin`insert into points_ledger (tenant_id, user_id, currency, delta, balance_after, event) values (${tenantId}, ${u}, 'bonuses', 0, 0, 'manual')`).rejects.toThrow()
    await expect(admin`insert into points_ledger (tenant_id, user_id, currency, delta, balance_after, event) values (${tenantId}, ${u}, 'bonuses', -1, -1, 'manual')`).rejects.toThrow()
    await expect(admin`insert into points_ledger (tenant_id, user_id, currency, delta, balance_after, event) values (${tenantId}, ${u}, 'bonuses', 1, 1, 'purchase')`).rejects.toThrow()
    await expect(admin`insert into points_ledger (tenant_id, user_id, currency, delta, balance_after, event) values (${tenantId}, ${u}, 'coins', 1, 1, 'manual')`).rejects.toThrow()
    await grant(u, 3)
    const seen = await withTenant(otherTenantId, null, tx => tx.execute(`select count(*)::int as n from points_ledger where user_id = '${u}'` as never)) as unknown as [{ n: number }]
    expect(seen[0].n).toBe(0)
  })
})

describe('начисление за выполненное задание (docs/15 §14.3, docs/21 §3.7)', () => {
  it('правило тенанта по типу контента; повторное завершение того же назначения не начисляет; уведомление bonus_earned', async () => {
    const u = await makePerson('Нагорода Правило')
    const a = await makeAssignment('resource')
    const base = { contentType: 'resource' as const, contentId: a.subjectId, assignmentId: a.id, sourceKind: 'resource_view' as const }
    expect((await completeTask(tenantId, u, { ...base, status: 'done' })).logged).toBe(true)
    await completeTask(tenantId, u, { ...base, status: 'failed' })
    await completeTask(tenantId, u, { ...base, status: 'done' })
    const rows = await ledgerOf(u)
    expect(rows.map(r => [r.currency, r.delta, r.event, r.ref_id])).toEqual([
      ['points', DEFAULT_TASK_REWARDS.resource.points, 'task_completed', a.id],
      ['bonuses', DEFAULT_TASK_REWARDS.resource.bonuses, 'task_completed', a.id],
    ])
    expect(rows[0]!.title).toMatch(/^Завдання resource/)
    const n = await admin`select code, payload from notifications where user_id = ${u} and code = 'bonus_earned'`
    expect(n).toHaveLength(1)
    expect(n[0]!.payload).toMatchObject({ amount: DEFAULT_TASK_REWARDS.resource.bonuses, balance: DEFAULT_TASK_REWARDS.resource.bonuses })
  })

  it('числа назначения перекрывают правило; явный 0 — «без нагороди»; правка правила тенанта действует на новые завершения', async () => {
    const u = await makePerson('Нагорода Призначення')
    const own = await makeAssignment('test', { points: 7, bonuses: 0 })
    await completeTask(tenantId, u, { contentType: 'test', contentId: own.subjectId, assignmentId: own.id, status: 'done', sourceKind: 'attempt' })
    expect((await ledgerOf(u)).map(r => [r.currency, r.delta])).toEqual([['points', 7]])

    const rules = await rewards.updateRewardRules(ctx(adminId), { taskRewards: { workshop: { points: 4, bonuses: 2 } } })
    expect(rules.taskRewards.workshop).toEqual({ points: 4, bonuses: 2 })
    expect(rules.taskRewards.course).toEqual(DEFAULT_TASK_REWARDS.course)
    const ws = await makeAssignment('workshop')
    await completeTask(tenantId, u, { contentType: 'workshop', contentId: ws.subjectId, assignmentId: ws.id, status: 'done', sourceKind: 'workshop_submission' })
    expect((await ledgerOf(u)).slice(1).map(r => [r.currency, r.delta])).toEqual([['points', 4], ['bonuses', 2]])
    const [audit] = await admin`select action from audit_log where tenant_id = ${tenantId} and action = 'settings.gamification' order by created_at desc limit 1`
    expect(audit).toBeDefined()
  })

  it('без задания ничего: контент без назначения, шаг программы, траектория; кандидату — ничего', async () => {
    const u = await makePerson('Без завдання')
    await completeTask(tenantId, u, { contentType: 'resource', contentId: crypto.randomUUID(), status: 'done', sourceKind: 'resource_view' })
    const program = await makeAssignment('training_program')
    // Курс внутри программы несёт назначение программы — это шаг, а не задание
    await completeTask(tenantId, u, { contentType: 'course', contentId: crypto.randomUUID(), assignmentId: program.id, status: 'done', sourceKind: 'enrollment' })
    await completeTask(tenantId, u, { contentType: 'trajectory', contentId: crypto.randomUUID(), status: 'done', sourceKind: 'trajectory_enrollment' })
    expect(await ledgerOf(u)).toHaveLength(0)

    const cand = await makePerson('Кандидат Нагорода', lazarevaId, 'candidate')
    const a = await makeAssignment('course')
    await completeTask(tenantId, cand, { contentType: 'course', contentId: a.subjectId, assignmentId: a.id, status: 'done', sourceKind: 'enrollment' })
    expect(await ledgerOf(cand)).toHaveLength(0)
  })

  it('модуль «Бонуси і магазин» выключен — бонусы не начисляются, баллы рейтинга начисляются', async () => {
    const { updateModules } = await import('../../server/services/settings')
    await updateModules(ctx(adminId), { bonuses: false })
    try {
      const u = await makePerson('Модуль вимкнено')
      const a = await makeAssignment('course')
      await completeTask(tenantId, u, { contentType: 'course', contentId: a.subjectId, assignmentId: a.id, status: 'done', sourceKind: 'enrollment' })
      expect((await ledgerOf(u)).map(r => r.currency)).toEqual(['points'])
    }
    finally {
      await updateModules(ctx(adminId), { bonuses: true })
    }
  })

  it('этап курса без «впливає на рейтинг» (counts_in_rating) — баллов нет, бонусы есть', async () => {
    const [stage] = await admin`select id from lifecycle_stages where tenant_id = ${tenantId} and code = 'knowledge'`
    const [course] = await admin`insert into courses (tenant_id, title, slug, status, lifecycle_stage_id) values (${tenantId}, ${`База знань ${stamp}`}, ${`kb-${stamp}`}, 'published', ${stage!.id}) returning id`
    courseIds.push(course!.id as string)
    const u = await makePerson('Етап без рейтингу')
    const a = await makeAssignment('course', {}, course!.id as string)
    await completeTask(tenantId, u, { contentType: 'course', contentId: a.subjectId, assignmentId: a.id, status: 'done', sourceKind: 'enrollment' })
    expect((await ledgerOf(u)).map(r => [r.currency, r.delta])).toEqual([['bonuses', DEFAULT_TASK_REWARDS.course.bonuses]])
  })

  it('D-069: «Поточний рейтинг» — сумма баллов рейтинга; бонусы и их трата рейтинг не трогают', async () => {
    const u = await makePerson('Рейтинг Балів')
    const a1 = await makeAssignment('course')
    const a2 = await makeAssignment('test')
    await completeTask(tenantId, u, { contentType: 'course', contentId: a1.subjectId, assignmentId: a1.id, status: 'done', sourceKind: 'enrollment' })
    await completeTask(tenantId, u, { contentType: 'test', contentId: a2.subjectId, assignmentId: a2.id, status: 'done', sourceKind: 'attempt' })
    await grant(u, 50)
    const item = await makeItem({ priceBonuses: 20 })
    expect((await shop.placeOrder(ctx(u), item)).ok).toBe(true)
    const h = await studyHistory(ctx(u), u)
    const expected = DEFAULT_TASK_REWARDS.course.points + DEFAULT_TASK_REWARDS.test.points
    expect(h.currentRating).toBe(expected)
    expect(h.series).toHaveLength(8)
    expect(h.series.at(-1)!.mine).toBe(expected)
    const me = await bonuses.myBonuses(ctx(u))
    expect(me.rating).toBe(expected)
    expect(me.balance).toBe(DEFAULT_TASK_REWARDS.course.bonuses + DEFAULT_TASK_REWARDS.test.bonuses + 50 - 20)
    expect(me.rows[0]).toMatchObject({ event: 'purchase', delta: -20 })
  })
})

describe('магазин: заказ, остаток, лимит, гонка (docs/21 Г-21.1)', () => {
  it('заказ резервирует на 14 дней, списывает бонусы строкой purchase и уменьшает остаток; без бонусов — отказ', async () => {
    const u = await makePerson('Покупець')
    const item = await makeItem({ priceBonuses: 15, stock: 3 })
    expect(await shop.placeOrder(ctx(u), item)).toMatchObject({ ok: false, code: 'insufficient_bonuses', details: { balance: 0, price: 15 } })
    await grant(u, 40)
    const r = await shop.placeOrder(ctx(u), item)
    if (!r.ok) throw new Error(r.code)
    expect(r.balance).toBe(25)
    expect(r.order).toMatchObject({ status: 'reserved', priceBonuses: 15, itemId: item })
    const days = (new Date(r.order.reservedUntil).getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(SHOP_RESERVE_DAYS - 0.01)
    expect(days).toBeLessThan(SHOP_RESERVE_DAYS + 0.01)
    expect((await admin`select stock from shop_items where id = ${item}`)[0]!.stock).toBe(2)
    expect((await ledgerOf(u)).at(-1)).toMatchObject({ event: 'purchase', delta: -15, balance_after: 25, ref_id: r.order.id })
    const sc = await shop.showcase(ctx(u))
    if (!sc.ok) throw new Error(sc.code)
    expect(sc.balance).toBe(25)
    expect(sc.items.find(i => i.id === item)).toMatchObject({ mine: 1, stock: 2, blocked: null })
    expect(sc.activeOrders).toBeGreaterThanOrEqual(1)
  })

  it('остаток null — без ограничения; лимит на человека держится; пустой остаток — out_of_stock', async () => {
    const u = await makePerson('Ліміт')
    await grant(u, 100)
    const dayOff = await makeItem({ priceBonuses: 10, stock: null, limitPerUser: 1 })
    expect((await shop.placeOrder(ctx(u), dayOff)).ok).toBe(true)
    expect(await shop.placeOrder(ctx(u), dayOff)).toMatchObject({ ok: false, code: 'limit_reached', details: { limit: 1 } })
    expect((await admin`select stock from shop_items where id = ${dayOff}`)[0]!.stock).toBeNull()
    const empty = await makeItem({ priceBonuses: 1, stock: 0 })
    expect(await shop.placeOrder(ctx(u), empty)).toMatchObject({ ok: false, code: 'out_of_stock' })
    const hidden = await makeItem({ priceBonuses: 1, isActive: false })
    expect(await shop.placeOrder(ctx(u), hidden)).toMatchObject({ ok: false, code: 'not_found' })
    const sc = await shop.showcase(ctx(u))
    if (!sc.ok) throw new Error(sc.code)
    expect(sc.items.find(i => i.id === dayOff)?.blocked).toBe('limit_reached')
    expect(sc.items.find(i => i.id === empty)?.blocked).toBe('out_of_stock')
    expect(sc.items.some(i => i.id === hidden)).toBe(false)
  })

  it('гонка: два одновременных заказа последней единицы — проходит ровно один', async () => {
    const [a, b] = [await makePerson('Гонка А'), await makePerson('Гонка Б')]
    await grant(a, 30)
    await grant(b, 30)
    const last = await makeItem({ priceBonuses: 10, stock: 1 })
    const results = await Promise.all([shop.placeOrder(ctx(a), last), shop.placeOrder(ctx(b), last)])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect(results.filter(r => !r.ok).map(r => (r as { code: string }).code)).toEqual(['out_of_stock'])
    expect((await admin`select stock from shop_items where id = ${last}`)[0]!.stock).toBe(0)
    expect(await admin`select count(*)::int as n from shop_orders where item_id = ${last}`).toMatchObject([{ n: 1 }])
    expect(await admin`select count(*)::int as n from points_ledger where event = 'purchase' and user_id in (${a}, ${b})`).toMatchObject([{ n: 1 }])
  })

  it('гонка: один человек дважды жмёт «Замовити» при лимите 1 — второй заказ не проходит, бонусы списаны один раз', async () => {
    const u = await makePerson('Подвійний клік')
    await grant(u, 50)
    const item = await makeItem({ priceBonuses: 10, stock: 5, limitPerUser: 1 })
    const results = await Promise.all([shop.placeOrder(ctx(u), item), shop.placeOrder(ctx(u), item), shop.placeOrder(ctx(u), item)])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect((await admin`select stock from shop_items where id = ${item}`)[0]!.stock).toBe(4)
    expect((await bonuses.myBonuses(ctx(u))).balance).toBe(40)
    expect(await ledgerSvc.ledgerDrift(tenantId)).toEqual([])
  })

  it('кандидат магазином не пользуется; чужой тенант — товар «не найден»', async () => {
    const cand = await makePerson('Кандидат Магазин', lazarevaId, 'candidate')
    expect(await shop.showcase(ctx(cand))).toEqual({ ok: false, code: 'not_employee' })
    const item = await makeItem()
    expect(await shop.placeOrder(ctx(cand), item)).toMatchObject({ ok: false, code: 'not_employee' })
    const [foreign] = await admin`insert into shop_items (tenant_id, title, price_bonuses, is_active) values (${otherTenantId}, 'Чужий', 1, true) returning id`
    try {
      const u = await makePerson('Чужий товар')
      await grant(u, 5)
      expect(await shop.placeOrder(ctx(u), foreign!.id as string)).toMatchObject({ ok: false, code: 'not_found' })
    }
    finally {
      await admin`delete from shop_items where id = ${foreign!.id}`
    }
  })
})

describe('выдача и отмена (docs/21 Г-21.1, docs/05 §5.14.10)', () => {
  it('ready → issued: кто и когда, audit_log, уведомление «можна забрати»; повторный переход — invalid_transition', async () => {
    const u = await makePerson('Отримувач')
    await grant(u, 30)
    const item = await makeItem({ priceBonuses: 10, locationId: lazarevaId })
    const o = await shop.placeOrder(ctx(u), item)
    if (!o.ok) throw new Error(o.code)
    const manager = await makePerson('Керівник Лазарева')
    const mgr = access(manager, ['shop.issue', 'bonus.grant'], lazarevaId)
    const ready = await shop.setOrderStatus(ctx(manager), mgr, o.order.id, { status: 'ready' })
    expect(ready).toMatchObject({ ok: true, order: { status: 'ready' } })
    expect(await admin`select code from notifications where user_id = ${u} and code = 'bonus_order_ready'`).toHaveLength(1)
    const issued = await shop.setOrderStatus(ctx(manager), mgr, o.order.id, { status: 'issued' })
    if (!issued.ok) throw new Error(issued.code)
    expect(issued.order.issuedAt).not.toBeNull()
    expect((await admin`select issued_by from shop_orders where id = ${o.order.id}`)[0]!.issued_by).toBe(manager)
    expect(await shop.setOrderStatus(ctx(manager), mgr, o.order.id, { status: 'cancelled', reason: 'Пізно' })).toMatchObject({ ok: false, code: 'invalid_transition' })
    const audit = await admin`select action from audit_log where entity = 'shop_order' and entity_id = ${o.order.id} order by created_at`
    expect(audit.map(a => a.action)).toEqual(['shop.order.ready', 'shop.order.issue'])
    const list = await shop.listOrders(ctx(manager), mgr, { tab: 'issued', limit: 100 })
    if (!list.ok) throw new Error(list.code)
    expect(list.rows.find(r => r.id === o.order.id)).toMatchObject({ fullName: 'Отримувач', issuedByName: 'Керівник Лазарева' })
  })

  it('отмена ответственным — только с причиной; возвращает бонусы строкой refund и остаток; уведомление с причиной', async () => {
    const u = await makePerson('Скасування')
    await grant(u, 20)
    const item = await makeItem({ priceBonuses: 12, stock: 2 })
    const o = await shop.placeOrder(ctx(u), item)
    if (!o.ok) throw new Error(o.code)
    const staff = access(adminId, ['shop.manage', 'shop.issue'])
    expect(await shop.setOrderStatus(ctx(adminId), staff, o.order.id, { status: 'cancelled' })).toMatchObject({ ok: false, code: 'reason_required' })
    const r = await shop.setOrderStatus(ctx(adminId), staff, o.order.id, { status: 'cancelled', reason: 'Товар пошкоджено' })
    expect(r).toMatchObject({ ok: true, order: { status: 'cancelled', cancelReason: 'Товар пошкоджено', cancelledBy: 'staff' } })
    expect((await ledgerOf(u)).at(-1)).toMatchObject({ event: 'refund', delta: 12, balance_after: 20, ref_id: o.order.id, comment: 'Товар пошкоджено' })
    expect((await admin`select stock from shop_items where id = ${item}`)[0]!.stock).toBe(2)
    const [n] = await admin`select payload from notifications where user_id = ${u} and code = 'bonus_order_cancelled'`
    expect(n!.payload).toMatchObject({ amount: 12, reason: 'Товар пошкоджено' })
    expect(await admin`select action from audit_log where entity = 'shop_order' and entity_id = ${o.order.id}`).toMatchObject([{ action: 'shop.order.cancel' }])
  })

  it('покупатель сам отменяет только ещё не подготовленный заказ; чужой заказ ему «не существует»', async () => {
    const u = await makePerson('Передумав')
    const other = await makePerson('Сусід')
    await grant(u, 30)
    const item = await makeItem({ priceBonuses: 10 })
    const o1 = await shop.placeOrder(ctx(u), item)
    const o2 = await shop.placeOrder(ctx(u), item)
    if (!o1.ok || !o2.ok) throw new Error('order')
    const learner = access(u, ['learn.view'])
    expect(await shop.setOrderStatus(ctx(other), access(other, ['learn.view']), o1.order.id, { status: 'cancelled' })).toMatchObject({ ok: false, code: 'not_found' })
    expect(await shop.setOrderStatus(ctx(u), learner, o1.order.id, { status: 'cancelled' })).toMatchObject({ ok: true, order: { status: 'cancelled', cancelledBy: 'self' } })
    expect(await shop.setOrderStatus(ctx(u), learner, o2.order.id, { status: 'issued' })).toMatchObject({ ok: false, code: 'forbidden' })
    await shop.setOrderStatus(ctx(adminId), access(adminId, ['shop.manage']), o2.order.id, { status: 'ready' })
    expect(await shop.setOrderStatus(ctx(u), learner, o2.order.id, { status: 'cancelled' })).toMatchObject({ ok: false, code: 'forbidden' })
    expect((await bonuses.myBonuses(ctx(u))).balance).toBe(20)
    const mine = await shop.myOrders(ctx(u))
    expect(mine.map(m => m.status).sort()).toEqual(['cancelled', 'ready'])
  })

  it('область выдачи: руководитель точки видит и выдаёт заказы своей точки; «будь-яка» точка — по точке человека', async () => {
    const atSeg = await makePerson('Працює на Сегедській', segedskaId)
    await grant(atSeg, 50)
    const anywhere = await makeItem({ priceBonuses: 5, locationId: null })
    const onlyLaz = await makeItem({ priceBonuses: 5, locationId: lazarevaId })
    const o1 = await shop.placeOrder(ctx(atSeg), anywhere)
    const o2 = await shop.placeOrder(ctx(atSeg), onlyLaz)
    if (!o1.ok || !o2.ok) throw new Error('order')
    const segMgr = await makePerson('Керівник Сегедська', segedskaId)
    const seg = access(segMgr, ['shop.issue'], segedskaId)
    const list = await shop.listOrders(ctx(segMgr), seg, { tab: 'pending', limit: 100 })
    if (!list.ok) throw new Error(list.code)
    expect(list.rows.map(r => r.id)).toContain(o1.order.id)
    expect(list.rows.map(r => r.id)).not.toContain(o2.order.id)
    expect(await shop.setOrderStatus(ctx(segMgr), seg, o2.order.id, { status: 'issued' })).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await shop.setOrderStatus(ctx(segMgr), seg, o1.order.id, { status: 'issued' })).toMatchObject({ ok: true })
    expect(await shop.listOrders(ctx(atSeg), access(atSeg, ['learn.view']), { tab: 'pending', limit: 10 })).toEqual({ ok: false, code: 'forbidden' })
  })

  it('shop.reserve_expire: просроченный резерв отменяется с возвратом и уведомлением; повторный проход ничего не делает', async () => {
    const u = await makePerson('Не прийшов')
    await grant(u, 25)
    const item = await makeItem({ priceBonuses: 20, stock: 1 })
    const o = await shop.placeOrder(ctx(u), item)
    if (!o.ok) throw new Error(o.code)
    await shop.setOrderStatus(ctx(adminId), access(adminId, ['shop.manage']), o.order.id, { status: 'ready' })
    await admin`update shop_orders set reserved_until = now() - interval '1 minute' where id = ${o.order.id}`
    const first = await shopReserveExpireTenant(tenantId, new Date(), true)
    expect(first.expired).toBeGreaterThanOrEqual(1)
    expect(first.drift).toBe(0)
    const [row] = await admin`select status, cancelled_by, cancel_reason from shop_orders where id = ${o.order.id}`
    expect(row).toMatchObject({ status: 'cancelled', cancelled_by: null, cancel_reason: null })
    expect((await admin`select stock from shop_items where id = ${item}`)[0]!.stock).toBe(1)
    expect((await bonuses.myBonuses(ctx(u))).balance).toBe(25)
    expect(await admin`select code from notifications where user_id = ${u} and code = 'bonus_order_expired'`).toHaveLength(1)
    expect((await shop.myOrders(ctx(u)))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'system' })
    expect(await shop.expireShopReservations(tenantId)).toBe(0)
  })
})

describe('ручные бонусы, журнал и реестр (docs/21 §14.9, docs/04 /bonuses/*)', () => {
  it('себе нельзя; не своя точка — forbidden; списание ниже нуля — insufficient; начисление — audit_log и уведомление', async () => {
    const u = await makePerson('Ручне нарахування')
    const mentor = await makePerson('Наставник Сегедська', segedskaId)
    const ment = access(mentor, ['bonus.grant'], segedskaId)
    expect(await bonuses.adjustBonuses(ctx(adminId), access(adminId, ['bonus.grant']), { userId: adminId, delta: 5, comment: 'Собі' })).toEqual({ ok: false, code: 'self' })
    expect(await bonuses.adjustBonuses(ctx(mentor), ment, { userId: u, delta: 5, comment: 'Допомога' })).toEqual({ ok: false, code: 'forbidden' })
    expect(await bonuses.adjustBonuses(ctx(adminId), access(adminId, ['bonus.grant']), { userId: u, delta: -1, comment: 'Помилка' })).toMatchObject({ ok: false, code: 'insufficient' })
    expect(await bonuses.adjustBonuses(ctx(adminId), access(adminId, ['bonus.grant']), { userId: u, delta: 7, comment: 'Допомога на іншій точці' })).toEqual({ ok: true, balance: 7 })
    expect((await ledgerOf(u)).at(-1)).toMatchObject({ event: 'manual', delta: 7, comment: 'Допомога на іншій точці' })
    expect(await admin`select action from audit_log where entity = 'user' and entity_id = ${u} and action = 'bonus.adjust'`).toHaveLength(1)
    expect(await admin`select code from notifications where user_id = ${u} and code = 'bonus_earned'`).toHaveLength(1)
    const cand = await makePerson('Кандидат Бонус', lazarevaId, 'candidate')
    expect(await bonuses.adjustBonuses(ctx(adminId), access(adminId, ['bonus.grant']), { userId: cand, delta: 1, comment: 'Кандидату' })).toEqual({ ok: false, code: 'not_found' })
  })

  it('журнал и реестр — в области; только сотрудники; баланс в журнале — остаток после операции', async () => {
    const seg = await makePerson('Реєстр Сегедська', segedskaId)
    const laz = await makePerson('Реєстр Лазарева', lazarevaId)
    await grant(seg, 9)
    await grant(laz, 4)
    const segMgr = await makePerson('Керівник Сегедської', segedskaId)
    const area = access(segMgr, ['bonus.grant'], segedskaId)
    const reg = await bonuses.balances(ctx(segMgr), area, { q: 'Реєстр', page: 1, perPage: 50 })
    if (!reg.ok) throw new Error(reg.code)
    expect(reg.rows.map(r => r.fullName)).toEqual(['Реєстр Сегедська'])
    expect(reg.rows[0]).toMatchObject({ balance: 9 })
    const all = await bonuses.balances(ctx(adminId), access(adminId, ['shop.manage']), { q: 'Реєстр', page: 1, perPage: 50 })
    if (!all.ok) throw new Error(all.code)
    expect(all.rows.map(r => r.fullName).sort()).toEqual(['Реєстр Лазарева', 'Реєстр Сегедська'])
    const canaries = await bonuses.balances(ctx(adminId), access(adminId, ['shop.manage']), { q: 'Канарка', page: 1, perPage: 50 })
    expect(canaries.ok && canaries.rows).toEqual([])

    const log = await bonuses.ledger(ctx(segMgr), area, { currency: 'bonuses', limit: 50 })
    if (!log.ok) throw new Error(log.code)
    expect(log.rows.some(r => r.userId === seg && r.balanceAfter === 9 && r.event === 'manual')).toBe(true)
    expect(log.rows.some(r => r.userId === laz)).toBe(false)
    const page1 = await bonuses.ledger(ctx(adminId), access(adminId, ['shop.manage']), { currency: 'bonuses', limit: 1 })
    if (!page1.ok) throw new Error(page1.code)
    expect(page1.rows).toHaveLength(1)
    expect(page1.cursor).not.toBeNull()
    const page2 = await bonuses.ledger(ctx(adminId), access(adminId, ['shop.manage']), { currency: 'bonuses', limit: 1, cursor: page1.cursor! })
    if (!page2.ok) throw new Error(page2.code)
    expect(page2.rows[0]!.id).toBeLessThan(page1.rows[0]!.id)
    expect(await bonuses.ledger(ctx(seg), access(seg, ['learn.view']), { currency: 'bonuses', limit: 5 })).toEqual({ ok: false, code: 'forbidden' })
  })
})

describe('категории и товары (docs/21 §14.3)', () => {
  it('стартовые категории засеяны; имя уникально без учёта регистра; категорию с товаром не удалить', async () => {
    const names = (await shop.listShopCategories(ctx(adminId))).map(c => c.name)
    expect(names).toEqual(expect.arrayContaining(['Мерч', 'Вихідні дні', 'Знижки', 'У закладі']))
    const c = await shop.createShopCategory(ctx(adminId), { name: `Солодощі ${stamp}` })
    if (!c.ok) throw new Error(c.code)
    categoryIds.push(c.category.id)
    expect(await shop.createShopCategory(ctx(adminId), { name: `солодощі ${stamp}` })).toEqual({ ok: false, code: 'name_taken' })
    await makeItem({ categoryId: c.category.id })
    expect(await shop.deleteShopCategory(ctx(adminId), c.category.id)).toEqual({ ok: false, code: 'in_use', used: 1 })
    const [foreignCat] = await admin`insert into shop_categories (tenant_id, name) values (${otherTenantId}, ${`Чужа ${stamp}`}) returning id`
    try {
      expect(await shop.createShopItem(ctx(adminId), { title: 'Чужа категорія', priceBonuses: 1, categoryId: foreignCat!.id as string })).toEqual({ ok: false, code: 'category_not_found' })
    }
    finally {
      await admin`delete from shop_categories where id = ${foreignCat!.id}`
    }
  })

  it('правка и мягкое удаление товара — в audit_log; удалённый пропадает из витрины и списка', async () => {
    const item = await makeItem({ priceBonuses: 3 })
    expect(await shop.updateShopItem(ctx(adminId), item, { priceBonuses: 4, stock: 7 })).toEqual({ ok: true })
    const row = (await shop.listShopItems(ctx(adminId))).find(i => i.id === item)
    expect(row).toMatchObject({ priceBonuses: 4, stock: 7, ordered: 0 })
    expect(await shop.deleteShopItem(ctx(adminId), item)).toBe(true)
    expect(await shop.deleteShopItem(ctx(adminId), item)).toBe(false)
    expect((await shop.listShopItems(ctx(adminId))).some(i => i.id === item)).toBe(false)
    const audit = await admin`select action from audit_log where entity = 'shop_item' and entity_id = ${item} order by created_at`
    expect(audit.map(a => a.action)).toEqual(['shop.item.create', 'shop.item.update', 'shop.item.delete'])
  })
})
