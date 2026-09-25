import { sql } from 'drizzle-orm'
import { bigserial, check, date, index, integer, jsonb, pgTable, smallint, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'
import { locations } from './org'

/**
 * Лента и карта активности человека (`docs/v2/38-people-extensions.md` §3.3, §7.9–§7.11; PR-34,
 * миграция `v2_user_activity`). Пишет сюда только `server/services/activity.ts`.
 *
 * **Событие — со снимком пояса и локальным днём.** Пояс разрешается в момент вставки
 * (`personTimezone()`: `users.timezone` → точка размещения на дату события → точка вакансии
 * кандидата → тенант), `local_date = (occurred_at at time zone tz)::date` считается один раз и
 * никогда не пересчитывается: перевод на точку в другом поясе не переписывает прошлую карту.
 * События живут 400 дней (`activity.purge`), агрегат по дням — бессрочно.
 */
export const userActivityEvents = pgTable('user_activity_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Одно из `USER_ACTIVITY_KINDS` (docs/02 «Перечисления» `user_activity_kind`). */
  kind: text('kind').notNull(),
  /** Мягкая полиморфная ссылка на источник (решение `44` В-11): имя таблицы и строка в ней. */
  refEntity: text('ref_entity'),
  refId: uuid('ref_id'),
  /** Где человек работал в момент события (размещение на дату события); у кандидата — точка вакансии. */
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
  tz: text('tz').notNull(),
  localDate: date('local_date').notNull(),
  /** Момент действия самого человека (Р-34.3): у оценки попытки — сдача, у принятого замечания — подача. */
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('idx_user_activity_events_tenant').on(t.tenantId, t.userId, t.localDate.desc()),
  index('idx_user_activity_events_purge').on(t.tenantId, t.occurredAt),
  check('user_activity_events_kind_chk', sql`${t.kind} in ('lesson_completed', 'attempt_submitted', 'attempt_graded', 'enrollment_started', 'enrollment_completed', 'workshop_submitted', 'checklist_run_completed', 'knowledge_read', 'survey_submitted', 'certificate_issued', 'review_graded', 'content_issue_accepted')`),
])

/**
 * Суточный агрегат (`38` §3.3, §7.10): строка на человеко-день. Счётчик, разбивка по видам и
 * уровень обновляются в транзакции события (`recordActivity()`), секунды дня сводит из сегментов
 * учёта времени задача `activity.aggregate` — писатели трогают разные колонки. Хранится
 * бессрочно: карта за прошлые годы после уборки событий строится по нему (критерий 12).
 */
export const userActivityDaily = pgTable('user_activity_daily', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  localDate: date('local_date').notNull(),
  eventsCount: integer('events_count').notNull().default(0),
  /** Зачтённые секунды сегментов учёта времени (PR-21) за локальный день; заливку не определяет. */
  secondsSpent: integer('seconds_spent').notNull().default(0),
  /** Разбивка по видам: `{"lesson_completed": 3, "attempt_graded": 1}`. */
  kinds: jsonb('kinds').$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
  /** 0…4 по числу событий (`activityLevel()`, `shared/domain/activity.ts`). */
  level: smallint('level').notNull().default(0),
  recalcedAt: timestamp('recalced_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  // Уникальный ключ и есть tenant-first индекс карты (контрактный тест №2) — второй не нужен
  unique('uq_user_activity_daily_day').on(t.tenantId, t.userId, t.localDate),
  check('user_activity_daily_counts_chk', sql`${t.eventsCount} >= 0 and ${t.secondsSpent} >= 0`),
  check('user_activity_daily_level_chk', sql`${t.level} between 0 and 4`),
])
