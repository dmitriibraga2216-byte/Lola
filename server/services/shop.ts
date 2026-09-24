import { and, asc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { locations, mediaAssets, shopCategories, shopItems, shopOrders, users } from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { withTenant } from '../utils/withTenant'
import { OPEN_ORDER_STATUSES, SHOP_RESERVE_DAYS } from '../../shared/domain/gamification'
import type { ShopOrderStatus } from '../../shared/enums'
import { CANCEL_REASON_MIN } from '../../shared/schemas/gamification'
import type { OrderStatusInput, OrdersFilter, ShopItemInput, ShopItemPatch } from '../../shared/schemas/gamification'
import type { Access } from './access'
import { areaForScope, can } from './access'
import { recordAudit } from './audit'
import { balanceOf, lockAccount, postEntry } from './pointsLedger'
import { enqueueNotification } from './notifications'
import { EMPLOYEE, personById } from './repo/people'
import { frameJoins } from './reportFrame'

/**
 * Магазин подарков (docs/21 §14.3, Г-21.1 `[решение]`; docs/05 §5.14.10; docs/02 «Корпоративный хаб»).
 *
 * Заказ — четыре статуса: `reserved` (бонусы списаны строкой `purchase`, остаток уменьшен) →
 * `ready` (подготовлено на точке) → `issued` (выдано: кто и когда) — либо `cancelled` (бонусы
 * возвращены строкой `refund`, остаток — обратно). Резерв живёт 14 дней от заказа; просроченный
 * отменяет задача `shop.reserve_expire`.
 *
 * Гонка «два заказа последней единицы» и лимит на человека решаются транзакционно: заказ берёт
 * строку товара `FOR UPDATE` и проверяет остаток и лимит уже под блокировкой, а списание — под
 * блокировкой счёта человека (`pointsLedger.lockAccount`). Порядок блокировок везде один:
 * заказ → товар → счёт, поэтому взаимных ожиданий нет.
 *
 * Права (docs/01 §1.3 «Мотивація»): заказать себе — без особого права (`learn.view`); отменить
 * свой ещё не подготовленный заказ — тоже. `shop.manage` — каталог и все заказы сети;
 * `shop.issue` — «До видачі» своей точки: точка выдачи товара, а у товара с «будь-якою» точкой —
 * точка самого человека. Выдача и отмена чужого заказа — в audit_log.
 */

export interface Ctx { tenantId: string, actorId: string }

const DAY_MS = 24 * 60 * 60 * 1000

// ── Категории ────────────────────────────────────────────────────────────────

export type CategoryResult =
  | { ok: true, category: { id: string, name: string, sort: number } }
  | { ok: false, code: 'not_found' | 'name_taken' | 'in_use', used?: number }

export async function listShopCategories(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select().from(shopCategories).orderBy(asc(shopCategories.sort), asc(shopCategories.name))
    const counts = await tx.execute(sql`select category_id as id, count(*)::int as n from shop_items where category_id is not null and deleted_at is null group by category_id`) as unknown as { id: string, n: number }[]
    const n = new Map(counts.map(c => [c.id, c.n]))
    return rows.map(c => ({ id: c.id, name: c.name, sort: c.sort, itemsCount: n.get(c.id) ?? 0 }))
  })
}

async function nameTaken(tx: TenantTx, name: string, exceptId?: string): Promise<boolean> {
  const rows = await tx.execute(sql`select 1 from shop_categories where lower(name) = lower(${name}) ${exceptId ? sql`and id <> ${exceptId}::uuid` : sql``} limit 1`) as unknown as unknown[]
  return rows.length > 0
}

export async function createShopCategory(ctx: Ctx, input: { name: string }): Promise<CategoryResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    if (await nameTaken(tx, input.name)) return { ok: false as const, code: 'name_taken' as const }
    const [{ max }] = await tx.select({ max: sql<number>`coalesce(max(${shopCategories.sort}), -1)::int` }).from(shopCategories) as [{ max: number }]
    const [c] = await tx.insert(shopCategories).values({ tenantId: ctx.tenantId, name: input.name, sort: max + 1 }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'shop.category.create', entity: 'shop_category', entityId: c!.id, after: { name: c!.name } })
    return { ok: true as const, category: { id: c!.id, name: c!.name, sort: c!.sort } }
  })
}

export async function updateShopCategory(ctx: Ctx, id: string, input: { name: string }): Promise<CategoryResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(shopCategories).where(eq(shopCategories.id, id))
    if (!before) return { ok: false as const, code: 'not_found' as const }
    if (await nameTaken(tx, input.name, id)) return { ok: false as const, code: 'name_taken' as const }
    const [c] = await tx.update(shopCategories).set({ name: input.name, updatedAt: new Date() }).where(eq(shopCategories.id, id)).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'shop.category.update', entity: 'shop_category', entityId: id, before: { name: before.name }, after: { name: c!.name } })
    return { ok: true as const, category: { id: c!.id, name: c!.name, sort: c!.sort } }
  })
}

/** Категория с товарами не удаляется — 409 `in_use`: сначала перенесите товары. */
export async function deleteShopCategory(ctx: Ctx, id: string): Promise<{ ok: true } | { ok: false, code: 'not_found' | 'in_use', used?: number }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.select().from(shopCategories).where(eq(shopCategories.id, id))
    if (!c) return { ok: false as const, code: 'not_found' as const }
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(shopItems).where(and(eq(shopItems.categoryId, id), isNull(shopItems.deletedAt))) as [{ n: number }]
    if (n > 0) return { ok: false as const, code: 'in_use' as const, used: n }
    await tx.delete(shopCategories).where(eq(shopCategories.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'shop.category.delete', entity: 'shop_category', entityId: id, before: { name: c.name } })
    return { ok: true as const }
  })
}

// ── Товары (управление) ──────────────────────────────────────────────────────

export interface AdminItemRow {
  id: string
  title: string
  description: string | null
  imageKey: string | null
  categoryId: string | null
  categoryName: string | null
  priceBonuses: number
  stock: number | null
  locationId: string | null
  locationName: string | null
  limitPerUser: number | null
  isActive: boolean
  /** «Замовлено»: все неотменённые заказы. */
  ordered: number
  /** Ждут выдачи: reserved + ready. */
  pending: number
}

/** «Магазин подарунків» → «Товари» (мокап ShopAdmin): товар · категорія · вартість · залишок · замовлено · опубліковано. */
export async function listShopItems(ctx: Ctx): Promise<AdminItemRow[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select i.id, i.title, i.description, i.image_key, i.category_id, c.name as category_name, i.price_bonuses, i.stock,
             i.location_id, l.name as location_name, i.limit_per_user, i.is_active,
             (select count(*)::int from shop_orders o where o.item_id = i.id and o.status <> 'cancelled') as ordered,
             (select count(*)::int from shop_orders o where o.item_id = i.id and o.status in ('reserved', 'ready')) as pending
      from shop_items i
      left join shop_categories c on c.id = i.category_id
      left join locations l on l.id = i.location_id
      where i.deleted_at is null
      order by i.created_at desc
    `) as unknown as Record<string, unknown>[]
    return rows.map(r => ({
      id: r.id as string,
      title: r.title as string,
      description: (r.description as string | null) ?? null,
      imageKey: (r.image_key as string | null) ?? null,
      categoryId: (r.category_id as string | null) ?? null,
      categoryName: (r.category_name as string | null) ?? null,
      priceBonuses: Number(r.price_bonuses),
      stock: r.stock == null ? null : Number(r.stock),
      locationId: (r.location_id as string | null) ?? null,
      locationName: (r.location_name as string | null) ?? null,
      limitPerUser: r.limit_per_user == null ? null : Number(r.limit_per_user),
      isActive: Boolean(r.is_active),
      ordered: Number(r.ordered),
      pending: Number(r.pending),
    }))
  })
}

export type ItemError = 'not_found' | 'category_not_found' | 'location_not_found' | 'image_not_found'

/** Ссылки товара — в этом тенанте (RLS отрезает чужие: чужая категория выглядит как несуществующая). */
async function checkRefs(tx: TenantTx, input: ShopItemPatch): Promise<ItemError | null> {
  if (input.categoryId) {
    const [c] = await tx.select({ id: shopCategories.id }).from(shopCategories).where(eq(shopCategories.id, input.categoryId))
    if (!c) return 'category_not_found'
  }
  if (input.locationId) {
    const [l] = await tx.select({ id: locations.id }).from(locations).where(eq(locations.id, input.locationId))
    if (!l) return 'location_not_found'
  }
  if (input.imageKey) {
    const [m] = await tx.select({ id: mediaAssets.id }).from(mediaAssets).where(eq(mediaAssets.id, input.imageKey))
    if (!m) return 'image_not_found'
  }
  return null
}

const auditItem = (i: typeof shopItems.$inferSelect) => ({ title: i.title, priceBonuses: i.priceBonuses, stock: i.stock, categoryId: i.categoryId, locationId: i.locationId, limitPerUser: i.limitPerUser, isActive: i.isActive })

export async function createShopItem(ctx: Ctx, input: ShopItemInput): Promise<{ ok: true, id: string } | { ok: false, code: ItemError }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const bad = await checkRefs(tx, input)
    if (bad) return { ok: false as const, code: bad }
    const [i] = await tx.insert(shopItems).values({
      tenantId: ctx.tenantId,
      title: input.title,
      description: input.description ?? null,
      imageKey: input.imageKey ?? null,
      categoryId: input.categoryId ?? null,
      priceBonuses: input.priceBonuses,
      stock: input.stock ?? null,
      locationId: input.locationId ?? null,
      limitPerUser: input.limitPerUser ?? null,
      isActive: input.isActive ?? false,
      createdBy: ctx.actorId,
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'shop.item.create', entity: 'shop_item', entityId: i!.id, after: auditItem(i!) })
    return { ok: true as const, id: i!.id }
  })
}

export async function updateShopItem(ctx: Ctx, id: string, patch: ShopItemPatch): Promise<{ ok: true } | { ok: false, code: ItemError }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(shopItems).where(and(eq(shopItems.id, id), isNull(shopItems.deletedAt))).for('update')
    if (!before) return { ok: false as const, code: 'not_found' as const }
    const bad = await checkRefs(tx, patch)
    if (bad) return { ok: false as const, code: bad }
    const set: Partial<typeof shopItems.$inferInsert> = { updatedAt: new Date() }
    for (const k of ['title', 'description', 'imageKey', 'categoryId', 'priceBonuses', 'stock', 'locationId', 'limitPerUser', 'isActive'] as const) {
      if (patch[k] !== undefined) (set as Record<string, unknown>)[k] = patch[k]
    }
    const [after] = await tx.update(shopItems).set(set).where(eq(shopItems.id, id)).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'shop.item.update', entity: 'shop_item', entityId: id, before: auditItem(before), after: auditItem(after!) })
    return { ok: true as const }
  })
}

/** Мягкое удаление: товар пропадает из витрины, заказы по нему и строки книги остаются. */
export async function deleteShopItem(ctx: Ctx, id: string): Promise<boolean> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [i] = await tx.update(shopItems).set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
      .where(and(eq(shopItems.id, id), isNull(shopItems.deletedAt))).returning()
    if (!i) return false
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'shop.item.delete', entity: 'shop_item', entityId: id, before: auditItem(i) })
    return true
  })
}

// ── Витрина и заказы сотрудника ─────────────────────────────────────────────

/** Почему заказать нельзя — сервер считает, клиент показывает (CLAUDE.md п. 3). */
export type OrderBlock = 'out_of_stock' | 'limit_reached' | 'insufficient'

export interface ShowcaseItem {
  id: string
  title: string
  description: string | null
  imageKey: string | null
  categoryId: string | null
  priceBonuses: number
  stock: number | null
  locationName: string | null
  limitPerUser: number | null
  /** Неотменённых заказов этого товара у человека. */
  mine: number
  blocked: OrderBlock | null
}

/** Кандидат магазином не пользуется (инвариант 17): витрины и заказов у него нет. */
async function isEmployee(tx: TenantTx, userId: string): Promise<boolean> {
  const [p] = await personById(tx, { kind: users.kind }, userId)
  return p?.kind === EMPLOYEE
}

/** «Магазин подарунків» (мокап Shop): «Вам доступно: N бонусів», категории, карточки с остатком и ценой. */
export async function showcase(ctx: Ctx): Promise<{ ok: true, balance: number, categories: { id: string, name: string }[], items: ShowcaseItem[], activeOrders: number } | { ok: false, code: 'not_employee' }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    if (!(await isEmployee(tx, ctx.actorId))) return { ok: false as const, code: 'not_employee' as const }
    const balance = await balanceOf(tx, ctx.actorId, 'bonuses')
    const rows = await tx.execute(sql`
      select i.id, i.title, i.description, i.image_key, i.category_id, i.price_bonuses, i.stock, l.name as location_name, i.limit_per_user,
             (select count(*)::int from shop_orders o where o.item_id = i.id and o.user_id = ${ctx.actorId}::uuid and o.status <> 'cancelled') as mine
      from shop_items i left join locations l on l.id = i.location_id
      where i.is_active and i.deleted_at is null
      order by (i.stock = 0) nulls first, i.price_bonuses, i.title
    `) as unknown as Record<string, unknown>[]
    const items: ShowcaseItem[] = rows.map((r) => {
      const stock = r.stock == null ? null : Number(r.stock)
      const limit = r.limit_per_user == null ? null : Number(r.limit_per_user)
      const mine = Number(r.mine)
      const price = Number(r.price_bonuses)
      const blocked: OrderBlock | null = stock === 0 ? 'out_of_stock' : limit !== null && mine >= limit ? 'limit_reached' : price > balance ? 'insufficient' : null
      return { id: r.id as string, title: r.title as string, description: (r.description as string | null) ?? null, imageKey: (r.image_key as string | null) ?? null, categoryId: (r.category_id as string | null) ?? null, priceBonuses: price, stock, locationName: (r.location_name as string | null) ?? null, limitPerUser: limit, mine, blocked }
    })
    const used = new Set(items.map(i => i.categoryId).filter(Boolean))
    const categories = (await tx.select({ id: shopCategories.id, name: shopCategories.name }).from(shopCategories).orderBy(asc(shopCategories.sort), asc(shopCategories.name)))
      .filter(c => used.has(c.id))
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(shopOrders)
      .where(and(eq(shopOrders.userId, ctx.actorId), inArray(shopOrders.status, [...OPEN_ORDER_STATUSES]))) as [{ n: number }]
    return { ok: true as const, balance, categories, items, activeOrders: n }
  })
}

export interface OrderRow {
  id: string
  status: ShopOrderStatus
  priceBonuses: number
  itemId: string
  itemTitle: string
  pickupLocation: string | null
  reservedUntil: string
  readyAt: string | null
  issuedAt: string | null
  cancelledAt: string | null
  cancelReason: string | null
  /** Кто отменил: self — сам человек, staff — ответственный, system — истёк резерв. */
  cancelledBy: 'self' | 'staff' | 'system' | null
  createdAt: string
}

const iso = (v: unknown): string | null => v == null ? null : new Date(v as string).toISOString()

/** «Придбані» (мокап Shop): свои заказы с состоянием — «Готується» → «Можна забрати» → «Видано» (docs/05 §5.14.10). */
export async function myOrders(ctx: Ctx): Promise<OrderRow[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select o.id, o.status, o.price_bonuses, o.item_id, i.title as item_title, l.name as pickup_location, o.reserved_until, o.ready_at,
             o.issued_at, o.cancelled_at, o.cancel_reason, o.cancelled_by, o.user_id, o.created_at
      from shop_orders o join shop_items i on i.id = o.item_id left join locations l on l.id = i.location_id
      where o.user_id = ${ctx.actorId}::uuid
      order by o.created_at desc limit 100
    `) as unknown as Record<string, unknown>[]
    return rows.map(orderRow)
  })
}

function orderRow(r: Record<string, unknown>): OrderRow {
  return {
    id: r.id as string,
    status: r.status as ShopOrderStatus,
    priceBonuses: Number(r.price_bonuses),
    itemId: r.item_id as string,
    itemTitle: r.item_title as string,
    pickupLocation: (r.pickup_location as string | null) ?? null,
    reservedUntil: iso(r.reserved_until)!,
    readyAt: iso(r.ready_at),
    issuedAt: iso(r.issued_at),
    cancelledAt: iso(r.cancelled_at),
    cancelReason: (r.cancel_reason as string | null) ?? null,
    cancelledBy: r.status !== 'cancelled' ? null : r.cancelled_by == null ? 'system' : r.cancelled_by === r.user_id ? 'self' : 'staff',
    createdAt: iso(r.created_at)!,
  }
}

export type PlaceOrderError = 'not_found' | 'not_employee' | 'out_of_stock' | 'limit_reached' | 'insufficient_bonuses'

/**
 * Заказ товара (docs/04 `POST /gift-store/items/:id/order`): резерв на 14 дней, списание
 * отрицательной строкой книги, остаток −1. Всё — одной транзакцией под блокировкой строки товара:
 * из двух одновременных заказов последней единицы проходит ровно один, второй получает `out_of_stock`.
 */
export async function placeOrder(ctx: Ctx, itemId: string): Promise<{ ok: true, order: OrderRow, balance: number } | { ok: false, code: PlaceOrderError, details?: Record<string, unknown> }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    if (!(await isEmployee(tx, ctx.actorId))) return { ok: false as const, code: 'not_employee' as const }
    const [item] = await tx.select().from(shopItems).where(and(eq(shopItems.id, itemId), isNull(shopItems.deletedAt))).for('update')
    if (!item || !item.isActive) return { ok: false as const, code: 'not_found' as const }
    if (item.stock !== null && item.stock < 1) return { ok: false as const, code: 'out_of_stock' as const }
    if (item.limitPerUser !== null) {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(shopOrders)
        .where(and(eq(shopOrders.itemId, item.id), eq(shopOrders.userId, ctx.actorId), ne(shopOrders.status, 'cancelled'))) as [{ n: number }]
      if (n >= item.limitPerUser) return { ok: false as const, code: 'limit_reached' as const, details: { limit: item.limitPerUser } }
    }
    await lockAccount(tx, ctx.tenantId, ctx.actorId, 'bonuses')
    const balance = await balanceOf(tx, ctx.actorId, 'bonuses')
    if (balance < item.priceBonuses) return { ok: false as const, code: 'insufficient_bonuses' as const, details: { balance, price: item.priceBonuses } }

    const [order] = await tx.insert(shopOrders).values({
      tenantId: ctx.tenantId,
      userId: ctx.actorId,
      itemId: item.id,
      priceBonuses: item.priceBonuses,
      status: 'reserved',
      reservedUntil: new Date(Date.now() + SHOP_RESERVE_DAYS * DAY_MS),
    }).returning()
    const posted = await postEntry(tx, { tenantId: ctx.tenantId, userId: ctx.actorId, currency: 'bonuses', delta: -item.priceBonuses, event: 'purchase', refId: order!.id, title: item.title })
    // Под блокировкой счёта остаток уже проверен — сюда попасть нельзя; бросаем, чтобы откатить заказ
    if (!posted.ok) throw new Error(`shop: списание не проведено (${posted.code})`)
    if (item.stock !== null) await tx.update(shopItems).set({ stock: sql`${shopItems.stock} - 1`, updatedAt: new Date() }).where(eq(shopItems.id, item.id))
    const [loc] = item.locationId ? await tx.select({ name: locations.name }).from(locations).where(eq(locations.id, item.locationId)) : []
    return {
      ok: true as const,
      balance: posted.balanceAfter,
      order: orderRow({ ...order, price_bonuses: order!.priceBonuses, item_id: item.id, item_title: item.title, pickup_location: loc?.name ?? null, reserved_until: order!.reservedUntil, ready_at: null, issued_at: null, cancelled_at: null, cancel_reason: null, cancelled_by: null, user_id: ctx.actorId, created_at: order!.createdAt }),
    }
  })
}

// ── Выдача (очередь «До видачі») ────────────────────────────────────────────

/**
 * Область выдачи: `null` — вся сеть (`shop.manage` или `shop.issue` на весь тенант), массив точек —
 * только свои, `undefined` — права нет вовсе.
 */
export async function shopStaffArea(access: Access): Promise<string[] | null | undefined> {
  if (can(access, 'shop.manage')) return null
  if (!can(access, 'shop.issue')) return undefined
  return areaForScope(access, 'shop.issue')
}

/** Точка, где выдают этот заказ: точка выдачи товара, а у «будь-якої» — основная точка человека. */
const PICKUP_POINT = sql`coalesce(i.location_id, pl.location_id)`

function areaSql(area: string[] | null): SQL {
  if (area === null) return sql``
  if (area.length === 0) return sql`and false`
  return sql`and ${PICKUP_POINT} in (${sql.join(area.map(id => sql`${id}::uuid`), sql`, `)})`
}

const TAB_STATUS: Record<OrdersFilter['tab'], readonly ShopOrderStatus[]> = {
  pending: OPEN_ORDER_STATUSES,
  issued: ['issued'],
  cancelled: ['cancelled'],
}

export interface StaffOrderRow extends OrderRow {
  userId: string
  fullName: string
  position: string | null
  location: string | null
  issuedByName: string | null
  cancelledByName: string | null
}

/** «До видачі · N» / «Видано» / «Скасовано» (мокап ShopAdmin) в области ответственного. */
export async function listOrders(ctx: Ctx, access: Access, f: OrdersFilter): Promise<{ ok: true, rows: StaffOrderRow[], counts: Record<OrdersFilter['tab'], number> } | { ok: false, code: 'forbidden' }> {
  const area = await shopStaffArea(access)
  if (area === undefined) return { ok: false, code: 'forbidden' }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const base = sql`
      from shop_orders o join shop_items i on i.id = o.item_id join users u on u.id = o.user_id
      ${frameJoins()}
      left join locations il on il.id = i.location_id
      left join users ib on ib.id = o.issued_by
      left join users cb on cb.id = o.cancelled_by
      where true ${areaSql(area)}`
    const statuses = TAB_STATUS[f.tab]
    const order = f.tab === 'pending' ? sql`o.reserved_until asc` : sql`coalesce(o.issued_at, o.cancelled_at) desc`
    const rows = await tx.execute(sql`
      select o.id, o.status, o.price_bonuses, o.item_id, i.title as item_title, il.name as pickup_location, o.reserved_until, o.ready_at,
             o.issued_at, o.cancelled_at, o.cancel_reason, o.cancelled_by, o.user_id, o.created_at,
             u.full_name, p.name as position, l.name as location, ib.full_name as issued_by_name, cb.full_name as cancelled_by_name
      ${base} and o.status in (${sql.join(statuses.map(s => sql`${s}`), sql`, `)})
        ${f.q ? sql`and (u.full_name ilike ${`%${f.q}%`} or i.title ilike ${`%${f.q}%`})` : sql``}
      order by ${order} limit ${f.limit}
    `) as unknown as Record<string, unknown>[]
    const [c] = await tx.execute(sql`
      select count(*) filter (where o.status in ('reserved', 'ready'))::int as pending,
             count(*) filter (where o.status = 'issued')::int as issued,
             count(*) filter (where o.status = 'cancelled')::int as cancelled
      ${base}
    `) as unknown as [{ pending: number, issued: number, cancelled: number }]
    return {
      ok: true as const,
      rows: rows.map(r => ({ ...orderRow(r), userId: r.user_id as string, fullName: r.full_name as string, position: (r.position as string | null) ?? null, location: (r.location as string | null) ?? null, issuedByName: (r.issued_by_name as string | null) ?? null, cancelledByName: (r.cancelled_by_name as string | null) ?? null })),
      counts: { pending: Number(c.pending), issued: Number(c.issued), cancelled: Number(c.cancelled) },
    }
  })
}

/** Из каких статусов допустим переход (docs/21 Г-21.1): `issued` — и из `reserved`, если человек пришёл сразу. */
const FROM: Record<OrderStatusInput['status'], readonly ShopOrderStatus[]> = {
  ready: ['reserved'],
  issued: ['reserved', 'ready'],
  cancelled: ['reserved', 'ready'],
}

export type OrderStatusError = 'not_found' | 'forbidden' | 'invalid_transition' | 'reason_required'

/**
 * Смена статуса заказа (docs/04 `POST /gift-store/orders/:id/status`). Сам покупатель может только
 * отменить свой заказ, пока его не подготовили (`reserved`); остальное — ответственный за выдачу
 * в своей области. Отмена ответственным требует причины: человеку объясняют, почему подарка не будет.
 */
export async function setOrderStatus(ctx: Ctx, access: Access, orderId: string, input: OrderStatusInput): Promise<{ ok: true, order: OrderRow } | { ok: false, code: OrderStatusError, details?: Record<string, unknown> }> {
  const area = await shopStaffArea(access)
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [o] = await tx.select().from(shopOrders).where(eq(shopOrders.id, orderId)).for('update')
    if (!o) return { ok: false as const, code: 'not_found' as const }
    const own = o.userId === ctx.actorId
    const selfCancel = own && input.status === 'cancelled' && o.status === 'reserved'
    if (!selfCancel) {
      // Не ответственный: чужой заказ «не существует», свой — только отмена до подготовки
      if (area === undefined) return own ? { ok: false as const, code: 'forbidden' as const } : { ok: false as const, code: 'not_found' as const }
      if (area !== null) {
        const [pt] = await tx.execute(sql`
          select ${PICKUP_POINT} as point from shop_orders o join shop_items i on i.id = o.item_id
          left join lateral (select up.location_id from user_placements up where up.user_id = o.user_id and up.ended_at is null order by up.is_primary desc, up.started_at desc limit 1) pl on true
          where o.id = ${o.id}::uuid
        `) as unknown as [{ point: string | null }]
        if (!pt?.point || !area.includes(pt.point)) return { ok: false as const, code: 'forbidden' as const }
      }
    }
    if (!FROM[input.status].includes(o.status as ShopOrderStatus)) return { ok: false as const, code: 'invalid_transition' as const, details: { from: o.status, to: input.status } }
    const [item] = await tx.select().from(shopItems).where(eq(shopItems.id, o.itemId)).for('update')
    const [loc] = item?.locationId ? await tx.select({ name: locations.name }).from(locations).where(eq(locations.id, item.locationId)) : []
    const now = new Date()

    if (input.status === 'cancelled') {
      const reason = input.reason?.trim() || null
      if (!selfCancel && (!reason || reason.length < CANCEL_REASON_MIN)) return { ok: false as const, code: 'reason_required' as const, details: { min: CANCEL_REASON_MIN } }
      await cancelOrderTx(tx, ctx.tenantId, o, item, { actorId: ctx.actorId, reason, notify: selfCancel ? null : 'cancelled' })
      if (!selfCancel) await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'shop.order.cancel', entity: 'shop_order', entityId: o.id, before: { status: o.status }, after: { status: 'cancelled', reason, refund: o.priceBonuses } })
    }
    else if (input.status === 'ready') {
      await tx.update(shopOrders).set({ status: 'ready', readyAt: now, updatedAt: now }).where(eq(shopOrders.id, o.id))
      await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'shop.order.ready', entity: 'shop_order', entityId: o.id, before: { status: o.status }, after: { status: 'ready' } })
      // docs/23 Г-23.1 «Бонусы»: bonus.order_ready — «можна забрати на точці»
      await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: o.userId, code: 'bonus_order_ready', payload: { title: item?.title ?? '', location: loc?.name ?? '', url: '/learn/shop?tab=orders' }, dedupKey: `bonus_order_ready:${o.id}` })
    }
    else {
      await tx.update(shopOrders).set({ status: 'issued', issuedBy: ctx.actorId, issuedAt: now, updatedAt: now }).where(eq(shopOrders.id, o.id))
      await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'shop.order.issue', entity: 'shop_order', entityId: o.id, before: { status: o.status }, after: { status: 'issued', issuedAt: now.toISOString() } })
    }
    const [row] = await tx.execute(sql`
      select o.id, o.status, o.price_bonuses, o.item_id, i.title as item_title, l.name as pickup_location, o.reserved_until, o.ready_at,
             o.issued_at, o.cancelled_at, o.cancel_reason, o.cancelled_by, o.user_id, o.created_at
      from shop_orders o join shop_items i on i.id = o.item_id left join locations l on l.id = i.location_id
      where o.id = ${o.id}::uuid
    `) as unknown as Record<string, unknown>[]
    return { ok: true as const, order: orderRow(row!) }
  })
}

/**
 * Отмена внутри транзакции (ответственным, самим человеком или по сроку резерва): статус,
 * остаток +1 у товара с учётом остатка, компенсирующая строка `refund` на списанную сумму.
 * Строка заказа и товара уже заблокированы вызывающим.
 */
async function cancelOrderTx(
  tx: TenantTx,
  tenantId: string,
  o: typeof shopOrders.$inferSelect,
  item: typeof shopItems.$inferSelect | undefined,
  opts: { actorId: string | null, reason: string | null, notify: 'cancelled' | 'expired' | null },
): Promise<void> {
  const now = new Date()
  await tx.update(shopOrders).set({ status: 'cancelled', cancelledAt: now, cancelledBy: opts.actorId, cancelReason: opts.reason, updatedAt: now }).where(eq(shopOrders.id, o.id))
  if (item && item.stock !== null) await tx.update(shopItems).set({ stock: sql`${shopItems.stock} + 1`, updatedAt: now }).where(eq(shopItems.id, item.id))
  const refund = await postEntry(tx, { tenantId, userId: o.userId, currency: 'bonuses', delta: o.priceBonuses, event: 'refund', refId: o.id, title: item?.title ?? null, comment: opts.reason, actorId: opts.actorId })
  if (!refund.ok && refund.code !== 'duplicate') throw new Error(`shop: возврат не проведён (${refund.code})`)
  if (opts.notify) {
    const code = opts.notify === 'expired' ? 'bonus_order_expired' : 'bonus_order_cancelled'
    await enqueueNotification(tx, { tenantId, userId: o.userId, code, payload: { title: item?.title ?? '', amount: o.priceBonuses, reason: opts.reason ?? '', url: '/learn/shop?tab=orders' }, dedupKey: `${code}:${o.id}` })
  }
}

/**
 * `shop.reserve_expire` (docs/21 Г-21.1: «Резерв живёт 14 дней, потом автоотмена с уведомлением»):
 * заказы `reserved`/`ready` с истёкшим `reserved_until` отменяются с возвратом бонусов и остатка.
 * Каждый заказ — своей транзакцией: сбой одного не держит остальные. Идемпотентно — повторный
 * проход по уже отменённому заказу ничего не делает (условие статуса под блокировкой строки).
 */
export async function expireShopReservations(tenantId: string, now = new Date()): Promise<number> {
  const due = await withTenant(tenantId, null, tx => tx.select({ id: shopOrders.id }).from(shopOrders)
    .where(and(inArray(shopOrders.status, [...OPEN_ORDER_STATUSES]), lt(shopOrders.reservedUntil, now))))
  let n = 0
  for (const { id } of due) {
    const done = await withTenant(tenantId, null, async (tx) => {
      const [o] = await tx.select().from(shopOrders)
        .where(and(eq(shopOrders.id, id), inArray(shopOrders.status, [...OPEN_ORDER_STATUSES]), lt(shopOrders.reservedUntil, now))).for('update')
      if (!o) return false
      const [item] = await tx.select().from(shopItems).where(eq(shopItems.id, o.itemId)).for('update')
      await cancelOrderTx(tx, tenantId, o, item, { actorId: null, reason: null, notify: 'expired' })
      await recordAudit(tx, { tenantId, actorId: null, action: 'shop.order.expire', entity: 'shop_order', entityId: o.id, before: { status: o.status, reservedUntil: o.reservedUntil.toISOString() }, after: { status: 'cancelled', refund: o.priceBonuses } })
      return true
    }).catch((err) => {
      console.error(`[shop.reserve_expire] ${tenantId}/${id}:`, err)
      return false
    })
    if (done) n++
  }
  return n
}
