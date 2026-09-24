import { sql } from 'drizzle-orm'
import { bigserial, boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'
import { locations } from './org'
import { POINTS_CURRENCIES, POINTS_EVENTS, SHOP_ORDER_STATUSES } from '../../../shared/enums'

/**
 * Геймификация: книга баллов и бонусов, магазин подарков (docs/02 §2.10 и «Корпоративный хаб»,
 * docs/21 §3.7, §14.3, §14.9, Г-21.1; миграция `gamification`). Перечни значений — из
 * `shared/enums.ts` (docs/02 «Перечисления»); CHECK строится из тех же массивов.
 */

/** `col in ('a','b',…)` из перечня shared/enums — вместо литералов в тексте схемы. */
function inList(column: unknown, values: readonly string[]) {
  return sql`${column} in (${sql.join(values.map(v => sql`${v}`), sql`, `)})`
}

/**
 * Книга операций (docs/21 §14.9 «Журнал операцій з бонусами»): классическая книга с остатком в
 * строке. Баланс человека по валюте — **не хранимое поле, а `balance_after` последней строки**;
 * строки не правятся и не удаляются — отмена заказа пишет компенсирующую строку `refund`.
 *
 * Идемпотентность начисления — уникальный индекс `(tenant_id, user_id, currency, event, ref_id)`:
 * одно завершение назначения (`task_completed`, `ref_id` = назначение) не начисляет дважды, одна
 * покупка не списывает дважды и не возвращается дважды. У ручной операции `ref_id` пуст
 * (null в индексе различны) — ручных строк может быть сколько угодно.
 *
 * `id bigserial` (docs/02 §2.10): порядок строк в книге — порядок вставки под блокировкой человека
 * (`pointsLedger.ts`), по нему и берётся «последняя строка».
 */
export const pointsLedger = pgTable('points_ledger', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Одно из `POINTS_CURRENCIES`: `points` — рейтинг, `bonuses` — магазин. */
  currency: text('currency').notNull(),
  delta: integer('delta').notNull(),
  /** Остаток этой валюты у человека после операции — «Бонуси після операції» журнала эталона. */
  balanceAfter: integer('balance_after').notNull(),
  /** Одно из `POINTS_EVENTS` — «Подія». */
  event: text('event').notNull(),
  /** `task_completed` — assignments.id; `purchase`/`refund` — shop_orders.id; `manual` — null. Тип ссылки задаёт `event`. */
  refId: uuid('ref_id'),
  /** «Деталі»: название задания или товара на момент операции (как `task_access_log.title`). */
  title: text('title'),
  /** Причина ручной операции или отмены заказа. */
  comment: text('comment'),
  /** Кто провёл операцию (`granted_by` в `21` §3.7); null — система или сам человек, совершивший покупку. */
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  /** CLAUDE.md п. 14: технический контекст пишется во все журналы одинаково. */
  requestContext: jsonb('request_context'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('points_ledger_once_uq').on(t.tenantId, t.userId, t.currency, t.event, t.refId),
  index('points_ledger_user_idx').on(t.tenantId, t.userId, t.currency, t.id),
  index('points_ledger_created_idx').on(t.tenantId, t.createdAt),
  check('points_ledger_currency_chk', inList(sql`currency`, POINTS_CURRENCIES)),
  check('points_ledger_event_chk', inList(sql`event`, POINTS_EVENTS)),
  check('points_ledger_delta_chk', sql`delta <> 0`),
  check('points_ledger_balance_chk', sql`balance_after >= 0`),
  check('points_ledger_ref_chk', sql`(event = 'manual') = (ref_id is null)`),
])

/**
 * Категории товаров (docs/21 §14.3: «КАТЕГОРІЇ» с «Додати нову категорію»). Свой справочник
 * тенанта, как `resource_categories` у ресурсов; стартовые категории засевает
 * `ensureTenantDefaults` (`DEFAULT_SHOP_CATEGORIES`), дальше их ведёт администратор.
 */
export const shopCategories = pgTable('shop_categories', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  sort: integer('sort').notNull().default(0),
}, t => [
  unique('shop_categories_tenant_name_uq').on(t.tenantId, t.name),
  check('shop_categories_name_chk', sql`char_length(name) between 1 and 60`),
])

/**
 * Товар (docs/21 Г-21.1 `[решение]`). `stock` null — без ограничения: у выходного дня или скидки
 * физического остатка нет, выдача — отметкой ответственного. `location_id` null — «будь-яка»
 * точка выдачи. `limit_per_user` null — без лимита. Удаление мягкое (`deleted_at`): на товар
 * ссылаются заказы и строки книги.
 */
export const shopItems = pgTable('shop_items', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  /** Изображение — `media_assets.id` (origin `content_cover`, как `cover_key` новости и ресурса). */
  imageKey: text('image_key'),
  categoryId: uuid('category_id').references(() => shopCategories.id, { onDelete: 'set null' }),
  priceBonuses: integer('price_bonuses').notNull(),
  stock: integer('stock'),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
  limitPerUser: integer('limit_per_user'),
  /** «Опубліковано»: неопубликованный товар в витрине не виден. */
  isActive: boolean('is_active').notNull().default(false),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, t => [
  index('shop_items_tenant_idx').on(t.tenantId, t.isActive),
  check('shop_items_title_chk', sql`char_length(title) between 2 and 120`),
  check('shop_items_price_chk', sql`price_bonuses between 1 and 10000`),
  check('shop_items_stock_chk', sql`stock is null or stock >= 0`),
  check('shop_items_limit_chk', sql`limit_per_user is null or limit_per_user >= 1`),
])

/**
 * Заказ (docs/02 «Корпоративный хаб», docs/21 Г-21.1): `reserved` → `ready` → `issued`, из
 * `reserved`/`ready` — `cancelled`. `price_bonuses` — снимок цены на момент заказа: возврат
 * при отмене — ровно списанное, даже если цену потом поменяли. `reserved_until` — 14 дней от
 * заказа (`SHOP_RESERVE_DAYS`), дальше автоотмена задачей `shop.reserve_expire`.
 */
export const shopOrders = pgTable('shop_orders', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  itemId: uuid('item_id').notNull().references(() => shopItems.id),
  priceBonuses: integer('price_bonuses').notNull(),
  /** Одно из `SHOP_ORDER_STATUSES`. */
  status: text('status').notNull().default('reserved'),
  reservedUntil: timestamp('reserved_until', { withTimezone: true }).notNull(),
  readyAt: timestamp('ready_at', { withTimezone: true }),
  issuedBy: uuid('issued_by').references(() => users.id, { onDelete: 'set null' }),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  /** Кто отменил; null при `cancelled` — автоотмена по сроку резерва. */
  cancelledBy: uuid('cancelled_by').references(() => users.id, { onDelete: 'set null' }),
  cancelReason: text('cancel_reason'),
}, t => [
  index('shop_orders_status_idx').on(t.tenantId, t.status, t.reservedUntil),
  index('shop_orders_user_idx').on(t.tenantId, t.userId, t.createdAt),
  index('shop_orders_item_idx').on(t.tenantId, t.itemId, t.status),
  check('shop_orders_status_chk', inList(sql`status`, SHOP_ORDER_STATUSES)),
  check('shop_orders_price_chk', sql`price_bonuses >= 1`),
  check('shop_orders_issued_chk', sql`(status = 'issued') = (issued_at is not null)`),
  check('shop_orders_cancelled_chk', sql`(status = 'cancelled') = (cancelled_at is not null)`),
])
