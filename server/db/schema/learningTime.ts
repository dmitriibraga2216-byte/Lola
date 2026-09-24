import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'
import { enrollments } from './learning'

/**
 * Учёт времени биениями (`docs/v2/37-review-delegation.md` §3.6, §7.10–7.15; PR-21,
 * миграция `0078_v2_learning_time`).
 *
 * **Время считается биениями, а не разницей «открыл — закрыл»** (сквозная проверка 22,
 * `docs/v2/42` §5). Экран прохождения каждые 30 секунд сообщает, сколько из них человек был
 * активен; сервер зачитывает не больше этого, не больше прошедшего по своим часам и не больше
 * 30 секунд. Строка таблицы — **сегмент**: непрерывный отрезок одного экрана (`session_key`),
 * в который складываются биения (`beats_count`). Пишет сюда только
 * `server/services/learningTime*.ts`.
 */
export const learningTimeSessions = pgTable('learning_time_sessions', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  enrollmentId: uuid('enrollment_id').references(() => enrollments.id, { onDelete: 'cascade' }),
  /** Одно из `LEARNING_TIME_SUBJECT_TYPES`; ссылка мягкая, без FK (решение `44` В-11). */
  subjectType: text('subject_type').notNull(),
  subjectId: uuid('subject_id').notNull(),
  /** `content` — изучение материала, `attempt` — выполнение задания (`37` §7.12). */
  kind: text('kind').notNull(),
  sessionKey: uuid('session_key').notNull(),
  segmentNo: integer('segment_no').notNull().default(1),
  beatsCount: integer('beats_count').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  lastBeatAt: timestamp('last_beat_at', { withTimezone: true }).notNull(),
  /** Одна из семи причин `LEARNING_TIME_CLOSED_REASONS`; null — сегмент открыт. */
  closedReason: text('closed_reason'),
  /** Зачтено, не больше 5400 (потолок сегмента 90 минут, `37` §7.11). */
  creditedSeconds: integer('credited_seconds').notNull().default(0),
  /** Выброшено: неактивная часть интервала, короткий сегмент, превышение потолков, старая догрузка. */
  discardedSeconds: integer('discarded_seconds').notNull().default(0),
  /** Из зачтённого — пришло при скрытой вкладке от воспроизведения медиа (потолок 1,5 × длины). */
  mediaSeconds: integer('media_seconds').notNull().default(0),
  /** Последнее принятое биение сеанса и его зачёт: повтор `(session_key, seq)` возвращает тот же `credited`. */
  lastSeq: integer('last_seq').notNull().default(0),
  lastCredit: integer('last_credit').notNull().default(0),
  device: text('device'),
  isOfflineReplay: boolean('is_offline_replay').notNull().default(false),
}, t => [
  index('idx_learning_time_sessions_tenant').on(t.tenantId, t.userId, t.subjectType, t.subjectId, t.kind),
  index('idx_learning_time_sessions_open').on(t.tenantId, t.lastBeatAt).where(sql`closed_reason is null`),
  index('idx_learning_time_sessions_updated').on(t.tenantId, t.updatedAt),
  /** Открытый сегмент у пары «человек × элемент» один (`37` §4, Р-21.4) — инвариант базы. */
  uniqueIndex('uq_learning_time_sessions_open_pair').on(t.tenantId, t.userId, t.subjectType, t.subjectId).where(sql`closed_reason is null`),
  unique('uq_learning_time_sessions_segment').on(t.tenantId, t.sessionKey, t.segmentNo),
  check('lts_kind_chk', sql`${t.kind} in ('content', 'attempt')`),
  check('lts_subject_chk', sql`${t.subjectType} in ('lesson', 'quiz', 'workshop', 'track_node')`),
  check('lts_closed_chk', sql`${t.closedReason} is null or ${t.closedReason} in ('completed', 'idle_timeout', 'segment_cap', 'daily_cap', 'navigated_away', 'session_end', 'stale')`),
  check('lts_credited_chk', sql`${t.creditedSeconds} between 0 and 5400`),
  check('lts_discarded_chk', sql`${t.discardedSeconds} >= 0`),
  check('lts_media_chk', sql`${t.mediaSeconds} between 0 and ${t.creditedSeconds}`),
  check('lts_counters_chk', sql`${t.segmentNo} >= 1 and ${t.beatsCount} >= 0 and ${t.lastSeq} >= 0 and ${t.lastCredit} between 0 and 30`),
  check('lts_time_chk', sql`${t.lastBeatAt} >= ${t.startedAt}`),
])

/**
 * Витрина времени «человек × элемент × запись на курс» (`37` §3.6, §7.12). Пересчитывается
 * задачей `time.rollup` из сегментов целиком (свёртка идемпотентна: два прогона подряд дают
 * одно и то же), горячий путь биения её не трогает. `nulls not distinct` — прохождение вне
 * курса тоже одна строка на ключ.
 */
export const learningTimeTotals = pgTable('learning_time_totals', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  enrollmentId: uuid('enrollment_id').references(() => enrollments.id, { onDelete: 'cascade' }),
  subjectType: text('subject_type').notNull(),
  subjectId: uuid('subject_id').notNull(),
  /** Одно из `REVIEW_TIME_CONFIDENCE` (`37` §7.15). */
  confidence: text('confidence').notNull().default('ok'),
  contentSeconds: integer('content_seconds').notNull().default(0),
  attemptSeconds: integer('attempt_seconds').notNull().default(0),
  discardedSeconds: integer('discarded_seconds').notNull().default(0),
  sessionsCount: integer('sessions_count').notNull().default(0),
  firstStartedAt: timestamp('first_started_at', { withTimezone: true }),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
}, t => [
  index('idx_learning_time_totals_tenant').on(t.tenantId, t.subjectType, t.subjectId),
  unique('uq_learning_time_totals_key').on(t.tenantId, t.userId, t.subjectType, t.subjectId, t.enrollmentId).nullsNotDistinct(),
  check('ltt_conf_chk', sql`${t.confidence} in ('ok', 'partial', 'unreliable')`),
  check('ltt_subject_chk', sql`${t.subjectType} in ('lesson', 'quiz', 'workshop', 'track_node')`),
  check('ltt_seconds_chk', sql`${t.contentSeconds} >= 0 and ${t.attemptSeconds} >= 0 and ${t.discardedSeconds} >= 0 and ${t.sessionsCount} >= 0`),
])
