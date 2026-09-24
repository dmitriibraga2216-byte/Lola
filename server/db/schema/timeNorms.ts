import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'

/**
 * «Розрахунковий час» элемента контента (`docs/v2/37-review-delegation.md` §3.5, §7.13–7.14;
 * PR-22, миграция `0085_v2_time_norms`). Одна норма на элемент — урок, тест, практикум или шаг
 * траектории; элемент — та же мягкая полиморфная пара, по которой меряется время
 * (`learning_time_sessions.subject_type/subject_id`, решение `44` В-11).
 *
 * **Норма и флаг — сигнал качества материала, а не оценка человека** (§7.14): строка хранит
 * только агрегаты по элементу — медиану, p25, p75 и размер выборки, ни одного человека. Ни
 * одна формула балла, зачёта, рейтинга и начисления баллов эту таблицу не читает (тринадцатая
 * сквозная проверка `scripts/v2-crosschecks.sh`).
 *
 * Пишут только `server/services/timeNorms.ts` (форма нормы §6.3, «Застосувати», еженедельный
 * `time.norms_recalc`) и синхронизация «Орієнтовного часу» материала при его сохранении.
 */
export const contentTimeNorms = pgTable('content_time_norms', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  /** Одно из `LEARNING_TIME_SUBJECT_TYPES`; ссылка мягкая, без FK (решение `44` В-11). */
  subjectType: text('subject_type').notNull(),
  subjectId: uuid('subject_id').notNull(),
  /** Одно из `CONTENT_TIME_NORM_SOURCES`: `author` | `auto` | `observed`. */
  source: text('source').notNull().default('auto'),
  /**
   * Число, которое утвердил автор: введённое в форме §6.3, «Орієнтовний час» материала или
   * медиана, принятая «Застосувати» (`source = 'observed'`, замораживается в момент нажатия —
   * Р-22.2). Пересчёт `observed_seconds` его не трогает.
   */
  authorSeconds: integer('author_seconds'),
  /** Расчёт по объёму (§7.13): текст, длительность медиа, число вопросов. У практикума — null. */
  autoSeconds: integer('auto_seconds'),
  /** Медиана факта по достоверным завершённым прохождениям; null, пока выборка меньше 10 (Р-22.4). */
  observedSeconds: integer('observed_seconds'),
  observedP25: integer('observed_p25'),
  observedP75: integer('observed_p75'),
  /** Сколько достоверных (`confidence <> 'unreliable'`) завершённых прохождений в выборке. */
  observedSample: integer('observed_sample').notNull().default(0),
  /** Одно из `CONTENT_TIME_DEVIATION_FLAGS`; пока выборки нет — `no_data` (Р-22.3). */
  deviationFlag: text('deviation_flag').notNull().default('no_data'),
  /** Последний пересчёт `time.norms_recalc`. */
  recalculatedAt: timestamp('recalculated_at', { withTimezone: true }),
  /** Кто последним менял норму руками (форма, «Застосувати»); пересчёт его не трогает. */
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
}, t => [
  // Полный индекс с tenant_id первым (контрактный тест 2): фильтр по флагу отклонения
  index('idx_content_time_norms_tenant').on(t.tenantId, t.subjectType, t.deviationFlag),
  /** Одна норма на элемент (`37` §3.5). */
  unique('uq_content_time_norms_subject').on(t.tenantId, t.subjectType, t.subjectId),
  check('ctn_subject_chk', sql`${t.subjectType} in ('lesson', 'quiz', 'workshop', 'track_node')`),
  check('ctn_source_chk', sql`${t.source} in ('author', 'auto', 'observed')`),
  check('ctn_author_chk', sql`${t.authorSeconds} is null or ${t.authorSeconds} between 60 and 216000`),
  check('ctn_flag_chk', sql`${t.deviationFlag} in ('none', 'too_fast', 'too_slow', 'no_data')`),
  check('ctn_author_source_chk', sql`${t.source} = 'auto' or ${t.authorSeconds} is not null`),
  check('ctn_observed_chk', sql`${t.observedSample} >= 0 and (${t.autoSeconds} is null or ${t.autoSeconds} > 0)
    and (${t.observedSeconds} is null or (${t.observedSeconds} >= 0 and ${t.observedP25} <= ${t.observedSeconds} and ${t.observedSeconds} <= ${t.observedP75}))`),
])
