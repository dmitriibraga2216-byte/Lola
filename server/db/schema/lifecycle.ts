import { sql } from 'drizzle-orm'
import { boolean, index, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import type { StageCapabilityMap } from '../../../shared/enums'

/**
 * Справочник этапов жизненного цикла (docs/v2/33-lifecycle.md §3.2, docs/v2/40 §0005).
 *
 * Гибридная модель (docs/v2/44-decisions.md В-3): свободный каталог `course_categories`
 * остаётся основой, этап — **необязательный** атрибут курса, а разное поведение выражено
 * не веткой по названию, а картой возможностей `capabilities`. Код спрашивает «можно ли
 * здесь считать прогресс» через `stageCan()` (`server/services/lifecycle.ts`), а не
 * «это база знаний или нет».
 *
 * `code` неизменяем и закрыт констрейнтом на восемь платформенных значений
 * (`shared/enums.ts` → `LIFECYCLE_STAGE_CODES`); тенант правит `name_uk`, `icon`, `color`,
 * `sort`, `is_enabled`, `expected_days`. `capabilities` меняет только оператор платформы
 * (`33` §2): для тенанта они только на чтение — `403 capabilities.readonly`.
 */
export const lifecycleStages = pgTable('lifecycle_stages', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  /** Один из `LIFECYCLE_STAGE_CODES`; неизменяем (`33` §3.2). */
  code: text('code').notNull(),
  nameUk: text('name_uk').notNull(),
  nameEn: text('name_en'),
  icon: text('icon'),
  /** Токен бренд-бука: ink | sun | teal | coral (CLAUDE.md п. 9). */
  color: text('color').notNull().default('ink'),
  sort: integer('sort').notNull(),
  isEnabled: boolean('is_enabled').notNull().default(true),
  /** Норма времени в этапе, дней (`33` §7.11) — только сигнал для отчёта «застрягли». */
  expectedDays: integer('expected_days'),
  /** Фиксированный перечень ключей `STAGE_CAPABILITIES`; отсутствующий ключ = false. */
  capabilities: jsonb('capabilities').notNull().default({}).$type<StageCapabilityMap>(),
  /**
   * Зеркало ключа `capabilities.applies_to_candidate` (`33` §3.3, правило §7.9): генерируемая
   * колонка, а не вторая копия правды — иначе флаг и карта возможностей разъезжаются.
   * Нужна как колонка, потому что по ней фильтруют список этапов в форме назначения кандидату.
   */
  appliesToCandidate: boolean('applies_to_candidate')
    .notNull()
    .generatedAlwaysAs(sql`coalesce((capabilities ->> 'applies_to_candidate')::boolean, false)`),
}, t => [
  unique().on(t.tenantId, t.code),
  index().on(t.tenantId, t.sort),
])
