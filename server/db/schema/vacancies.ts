import { sql } from 'drizzle-orm'
import { boolean, char, check, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'
import { locations, orgUnits, positions } from './org'
import { courseCategories, courseVersions, courses } from './content'

/**
 * Вакансии (docs/v2/29-vacancies.md §3, миграции 0071_v2_vacancies, 0072_v2_users_vacancy_fk).
 *
 * **Вакансия — не носитель правил прохождения** (инвариант 1 документа `29`, правило 11
 * корневого CLAUDE.md). Она указывает, какой курс назначить откликнувшемуся и с какими
 * параметрами, но параметры лежат здесь **шаблоном** (`assignmentTemplate`), а применяются
 * созданием обычной `assignments`. После создания назначения правки вакансии на него не
 * влияют (§7.12, критерий §13 к. 8). Ни одной колонки `attempts`, `pass_score`, `due_at`,
 * `time_limit` в этих таблицах нет и быть не должно — сквозная проверка 13 (`42` §5).
 *
 * Критерии оценки (`vacancyCriteria`) — рамка человеческого решения, а не правило: они
 * ничего не блокируют, их единственный выход — свёртка в `candidate_scores` с
 * `kind = 'recruiter'` (`29` §3.3, `28` §3.4).
 */

/**
 * Шаблон вакансии (`29` §3.4) — самостоятельная сущность, а не вакансия-черновик: иначе
 * шаблоны попали бы в реестр вакансий, в отчёты воронки и получили бы публичные ссылки.
 *
 * `payload` — снимок полей вакансии **кроме** точки, рекрутера, токена, даты публикации,
 * состояния и статистики; `criteria` и `languages` вложены, чтобы применение шаблона шло
 * одной транзакцией.
 */
export const vacancyTemplates = pgTable('vacancy_templates', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  criteria: jsonb('criteria').notNull().default(sql`'[]'::jsonb`),
  languages: jsonb('languages').notNull().default(sql`'[]'::jsonb`),
  usageCount: integer('usage_count').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
}, t => [
  unique('vacancy_templates_tenant_id_name_unique').on(t.tenantId, t.name),
  index('idx_vacancy_templates_tenant').on(t.tenantId, t.isActive, t.name),
  check('vacancy_templates_name_chk', sql`length(${t.name}) between 3 and 120`),
])

/**
 * Вакансия (`29` §3.1).
 *
 * `vacancies_public_chk` — правило эталона «без курса и точки ссылка не создаётся»,
 * вынесенное в констрейнт БД, а не оставленное форме: ссылка без назначаемого курса — это
 * отклик, который некуда девать (§3.1 [решение], §7.1). Критерий §13 к. 1 закрыт на уровне
 * схемы — даже прямой UPDATE мимо сервиса ссылку не создаст.
 *
 * `uq_vacancies_public_token` — токен уникален глобально, а не внутри тенанта: публичная
 * страница приходит без сессии, и тенант выводится из самого токена (§10 [решение], П-04).
 */
export const vacancies = pgTable('vacancies', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  /** Одно из `VACANCY_STATES` (§4). */
  state: text('state').notNull().default('draft'),
  categoryId: uuid('category_id').references(() => courseCategories.id, { onDelete: 'set null' }),
  /** Рекрутер вакансии: попадает в `users.recruiter_id` откликнувшегося (§7.20). */
  recruiterId: uuid('recruiter_id').references(() => users.id, { onDelete: 'set null' }),
  /** «Рекрутинговий курс» — что назначается откликнувшемуся. Без него ссылки нет. */
  courseId: uuid('course_id').references(() => courses.id, { onDelete: 'set null' }),
  /** Версия курса фиксируется при публикации: правка курса не меняет отбор на лету. */
  courseVersionId: uuid('course_version_id').references(() => courseVersions.id, { onDelete: 'set null' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
  orgUnitId: uuid('org_unit_id').references(() => orgUnits.id, { onDelete: 'set null' }),
  positionId: uuid('position_id').references(() => positions.id, { onDelete: 'set null' }),
  descriptionHtml: text('description_html'),
  requirementsHtml: text('requirements_html'),
  dutiesHtml: text('duties_html'),
  extraHtml: text('extra_html'),
  /** Маркировка сгенерированного ИИ текста (§3.6): публикация запрещена с непроверенным. */
  aiBlocks: jsonb('ai_blocks').notNull().default(sql`'{}'::jsonb`),
  employmentType: text('employment_type'),
  workFormat: text('work_format'),
  countryCode: char('country_code', { length: 2 }),
  city: text('city'),
  experienceLevel: text('experience_level'),
  educationLevel: text('education_level'),
  salaryFrom: numeric('salary_from', { precision: 12, scale: 2 }),
  salaryTo: numeric('salary_to', { precision: 12, scale: 2 }),
  salaryCurrency: char('salary_currency', { length: 3 }).notNull().default('UAH'),
  salaryVisible: boolean('salary_visible').notNull().default(false),
  /**
   * Шаблон параметров назначения (§3.5) — **не** правила прохождения. Состав ключей —
   * `vacancyAssignmentTemplateSchema` (`shared/schemas/vacancies.ts`); при отклике из него
   * создаётся обычная `assignments`, и дальше живёт она, а не вакансия.
   */
  assignmentTemplate: jsonb('assignment_template').notNull().default(sql`'{}'::jsonb`),
  publicToken: text('public_token'),
  publicEnabled: boolean('public_enabled').notNull().default(false),
  publicApplyOtp: boolean('public_apply_otp').notNull().default(true),
  applyDailyCap: integer('apply_daily_cap').notNull().default(200),
  sourceBudget: numeric('source_budget', { precision: 12, scale: 2 }),
  templateId: uuid('template_id').references(() => vacancyTemplates.id, { onDelete: 'set null' }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  /** Одно из `VACANCY_CLOSE_REASONS`; текст — в `audit_log` перехода. */
  closeReason: text('close_reason'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
}, t => [
  unique('vacancies_tenant_id_public_token_unique').on(t.tenantId, t.publicToken),
  index('idx_vacancies_tenant').on(t.tenantId, t.state, t.updatedAt.desc()),
  index('idx_vacancies_tenant_location').on(t.tenantId, t.locationId),
  index('idx_vacancies_tenant_recruiter').on(t.tenantId, t.recruiterId),
  uniqueIndex('uq_vacancies_public_token').on(t.publicToken).where(sql`public_token is not null`),
  check('vacancies_state_chk', sql`${t.state} in ('draft', 'published', 'paused', 'closed', 'archived')`),
  check('vacancies_employment_chk', sql`${t.employmentType} is null or ${t.employmentType} in ('full_time', 'part_time', 'shift', 'temporary', 'internship', 'contract')`),
  check('vacancies_format_chk', sql`${t.workFormat} is null or ${t.workFormat} in ('on_site', 'hybrid', 'remote')`),
  check('vacancies_experience_chk', sql`${t.experienceLevel} is null or ${t.experienceLevel} in ('none', 'under_1y', '1_3y', '3_5y', 'over_5y')`),
  check('vacancies_education_chk', sql`${t.educationLevel} is null or ${t.educationLevel} in ('none', 'secondary', 'vocational', 'incomplete_higher', 'higher')`),
  check('vacancies_close_reason_chk', sql`${t.closeReason} is null or ${t.closeReason} in ('filled', 'no_need', 'budget', 'postponed', 'other')`),
  check('vacancies_salary_chk', sql`${t.salaryFrom} is null or ${t.salaryTo} is null or ${t.salaryFrom} <= ${t.salaryTo}`),
  check('vacancies_title_chk', sql`length(${t.title}) between 3 and 200`),
  check('vacancies_cap_chk', sql`${t.applyDailyCap} between 10 and 5000`),
  check('vacancies_public_chk', sql`not ${t.publicEnabled} or (${t.courseId} is not null and ${t.locationId} is not null and ${t.publicToken} is not null)`),
])

/** Требования по языкам (`29` §3.2, Г-29.4): пара «язык + уровень» плюс обязательность. */
export const vacancyLanguages = pgTable('vacancy_languages', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  vacancyId: uuid('vacancy_id').notNull().references(() => vacancies.id, { onDelete: 'cascade' }),
  langCode: text('lang_code').notNull(),
  /** Одно из `VACANCY_LANGUAGE_LEVELS`: шкала CEFR плюс `native`. */
  level: text('level').notNull(),
  isRequired: boolean('is_required').notNull().default(true),
  sort: integer('sort').notNull().default(0),
}, t => [
  unique('vacancy_languages_tenant_id_vacancy_id_lang_code_unique').on(t.tenantId, t.vacancyId, t.langCode),
  index('idx_vacancy_languages_tenant').on(t.tenantId, t.vacancyId, t.sort),
  check('vacancy_languages_level_chk', sql`${t.level} in ('a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'native')`),
])

/**
 * Критерий оценки кандидата (`29` §3.3, Г-29.5). Шкала задаётся явно (`scaleMin`/`scaleMax`):
 * без неё веса несравнимы между критериями, а формула свёртки перестаёт быть воспроизводимой.
 *
 * `isCritical` **не запрещает найм**: минимальный балл даёт предупреждение. Жёсткий
 * стоп-фактор был бы автоматизированным решением о человеке (инвариант 18, `28` §7.4).
 */
export const vacancyCriteria = pgTable('vacancy_criteria', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  vacancyId: uuid('vacancy_id').notNull().references(() => vacancies.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  weight: numeric('weight', { precision: 5, scale: 2 }).notNull().default('1'),
  scaleMin: numeric('scale_min', { precision: 6, scale: 2 }).notNull().default('0'),
  scaleMax: numeric('scale_max', { precision: 6, scale: 2 }).notNull().default('5'),
  isCritical: boolean('is_critical').notNull().default(false),
  /** Одно из `VACANCY_CRITERION_ORIGINS`. */
  origin: text('origin').notNull().default('manual'),
  sort: integer('sort').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
}, t => [
  index('idx_vacancy_criteria_tenant').on(t.tenantId, t.vacancyId, t.sort),
  check('vacancy_criteria_origin_chk', sql`${t.origin} in ('manual', 'ai', 'template')`),
  check('vacancy_criteria_weight_chk', sql`${t.weight} > 0 and ${t.weight} <= 100`),
  check('vacancy_criteria_scale_chk', sql`${t.scaleMax} > ${t.scaleMin}`),
  check('vacancy_criteria_name_chk', sql`length(${t.name}) between 2 and 120`),
])

/**
 * Балл по критерию (`29` §3.3). Один автор — один балл по одному критерию; второй рекрутер
 * оценивает того же кандидата своей строкой, а свёртка считается по всем авторам.
 */
export const vacancyCriterionScores = pgTable('vacancy_criterion_scores', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  candidateId: uuid('candidate_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  criterionId: uuid('criterion_id').notNull().references(() => vacancyCriteria.id, { onDelete: 'cascade' }),
  valueNum: numeric('value_num', { precision: 6, scale: 2 }).notNull(),
  comment: text('comment'),
  authorId: uuid('author_id').notNull().references(() => users.id),
}, t => [
  unique('vacancy_criterion_scores_unique').on(t.tenantId, t.candidateId, t.criterionId, t.authorId),
  index('idx_vacancy_criterion_scores_tenant').on(t.tenantId, t.candidateId),
])
