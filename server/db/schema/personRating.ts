import { sql } from 'drizzle-orm'
import { boolean, check, date, jsonb, numeric, pgTable, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'
import type { IndexBreakdown } from '../../../shared/domain/engagementIndex'

/**
 * Снимки індексу навчальної залученості (`docs/v2/38-people-extensions.md` §3.7, §7.1–§7.2;
 * PR-35, миграция `v2_person_rating`). Пишет сюда только `server/services/engagementIndex.ts` —
 * ночная задача `rating.recalc` и ручной пересчёт одного человека.
 *
 * **Не баллы рейтинга.** Имя таблицы — из DDL пакета; величина — индекс 0…130 %, пересчитываемый
 * целиком из первичных данных (`enrollments`, `user_activity_daily`), а не валюта `points_ledger`
 * (docs/33 D-069 «Поточний рейтинг»). Баллы в формулу не входят (`38` §7.1 [решение]).
 *
 * Снимок — источник истины для `users.rating_pct` и для экрана «Звідки взявся мій відсоток»:
 * `breakdown` хранит числа, подставленные в формулу, чтобы экран их показывал, а не пересчитывал,
 * и чтобы смена формулы (`formula_version`) не переписывала историю молча (§7.2).
 */
export const personRatingSnapshots = pgTable('person_rating_snapshots', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Дата расчёта в календаре тенанта; один снимок на человека в день (повторный расчёт — upsert). */
  calcDate: date('calc_date').notNull(),
  /** `B`, 0…100. */
  basePct: numeric('base_pct', { precision: 5, scale: 1 }).notNull(),
  /** `E`, `S`, `H` — каждый 0…10. */
  bonusEarly: numeric('bonus_early', { precision: 4, scale: 1 }).notNull().default('0'),
  bonusStreak: numeric('bonus_streak', { precision: 4, scale: 1 }).notNull().default('0'),
  bonusHelp: numeric('bonus_help', { precision: 4, scale: 1 }).notNull().default('0'),
  /** `min(130, B + E + S + H)` — выше 100 не обрезается (`38` §12). */
  totalPct: numeric('total_pct', { precision: 5, scale: 1 }).notNull(),
  breakdown: jsonb('breakdown').notNull().default({}).$type<IndexBreakdown | Record<string, never>>(),
  windowFrom: date('window_from').notNull(),
  windowTo: date('window_to').notNull(),
  /** Текущий снимок — ровно один на человека (`uq_person_rating_current`); у «не рассчитан» его нет. */
  isCurrent: boolean('is_current').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  // Он же tenant-first индекс «история человека по датам» (контрактный тест 2): отдельный
  // `(tenant_id, user_id, calc_date desc)` был бы тем же btree, читаемым в обратном порядке
  unique('uq_person_rating_day').on(t.tenantId, t.userId, t.calcDate),
  uniqueIndex('uq_person_rating_current').on(t.tenantId, t.userId).where(sql`is_current`),
  check('person_rating_total_chk', sql`${t.totalPct} between 0 and 130`),
  check('person_rating_parts_chk', sql`${t.basePct} between 0 and 100 and ${t.bonusEarly} between 0 and 10 and ${t.bonusStreak} between 0 and 10 and ${t.bonusHelp} between 0 and 10`),
  check('person_rating_window_chk', sql`${t.windowFrom} <= ${t.windowTo}`),
])
