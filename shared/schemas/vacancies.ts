import { z } from 'zod'
import { assignmentParamsSchema, remindersSchema } from './assignments'
import {
  VACANCY_CLOSE_REASONS, VACANCY_CRITERION_ORIGINS, VACANCY_EDUCATION_LEVELS,
  VACANCY_EMPLOYMENT_TYPES, VACANCY_EXPERIENCE_LEVELS, VACANCY_LANGUAGE_LEVELS,
  VACANCY_STATES, VACANCY_WORK_FORMATS,
} from '../enums'

/**
 * Контракты вакансий (docs/v2/29-vacancies.md §6, §10). Один источник для клиента и сервера
 * (CLAUDE.md п. 7).
 *
 * **Главное правило файла — инвариант 1 документа `29` (он же правило 11 CLAUDE.md):
 * вакансия не носитель правил прохождения.** Здесь нет и не может быть ключей «попытки»,
 * «проходной балл», «срок», «ограничение времени» — они существуют ровно в одном месте,
 * `shared/schemas/assignments.ts`, и попадают в вакансию только целиком, внутрь
 * `assignmentTemplate.params`, через импортированную схему параметров назначения. Ни одного
 * имени такого ключа в этом файле не написано, и это проверяется: сквозная проверка 13
 * (`docs/v2/42-stages-delta.md` §5, `scripts/v2-crosschecks.sh`) грепает по этому файлу и
 * обязана возвращать пусто.
 */

const title = z.string().trim().min(3).max(200)
const html = z.string().trim().max(20_000)

/**
 * Шаблон параметров назначения (`29` §3.5).
 *
 * Не «правила вакансии», а заготовка для будущей `assignments`: при отклике создаётся
 * обычное назначение, и дальше живёт оно (§7.12, критерий §13 к. 8). Состав `params`
 * импортируется из схемы назначения целиком — второго перечня ключей прохождения в
 * продукте не существует, и вакансия его не заводит.
 *
 * [гипотеза] `29` §3.5 показывает в примере `due_mode: "relative"` и не оговаривает
 * абсолютный срок. [решение] Абсолютной даты в шаблоне нет: вакансия живёт месяцами, а
 * зафиксированное в ней «до 3 березня» тихо протухает и выдаёт откликнувшемуся просроченное
 * назначение в момент создания. Относительный срок (`dueDays` от выдачи) — единственный,
 * который остаётся верным через полгода после заполнения формы.
 */
export const vacancyAssignmentTemplateSchema = z
  .object({
    dueMode: z.enum(['none', 'relative']).default('relative'),
    dueDays: z.number().int().min(1).max(365).nullable().optional(),
    isMandatory: z.boolean().default(true),
    /** Параметры прохождения будущего назначения — один перечень на продукт. */
    params: assignmentParamsSchema.default({}),
    reminders: remindersSchema.partial().default({}),
    notifyOnAssign: z.boolean().default(true),
  })
  .strict()

export type VacancyAssignmentTemplate = z.infer<typeof vacancyAssignmentTemplateSchema>
export const EMPTY_ASSIGNMENT_TEMPLATE: VacancyAssignmentTemplate = vacancyAssignmentTemplateSchema.parse({})

/** Требование по языку (`29` §3.2, Г-29.4): уровень CEFR плюс отметка обязательности. */
export const vacancyLanguageSchema = z
  .object({
    langCode: z.string().trim().min(2).max(5),
    level: z.enum(VACANCY_LANGUAGE_LEVELS),
    isRequired: z.boolean().default(true),
    sort: z.number().int().min(0).max(100).default(0),
  })
  .strict()

export type VacancyLanguageInput = z.infer<typeof vacancyLanguageSchema>

/** Общие поля формы вакансии (`29` §6.1). */
const vacancyFields = {
  title,
  categoryId: z.string().uuid().nullable().optional(),
  recruiterId: z.string().uuid().nullable().optional(),
  courseId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
  orgUnitId: z.string().uuid().nullable().optional(),
  positionId: z.string().uuid().nullable().optional(),
  descriptionHtml: html.nullable().optional(),
  requirementsHtml: html.nullable().optional(),
  dutiesHtml: html.nullable().optional(),
  extraHtml: html.nullable().optional(),
  employmentType: z.enum(VACANCY_EMPLOYMENT_TYPES).nullable().optional(),
  workFormat: z.enum(VACANCY_WORK_FORMATS).nullable().optional(),
  countryCode: z.string().trim().length(2).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  experienceLevel: z.enum(VACANCY_EXPERIENCE_LEVELS).nullable().optional(),
  educationLevel: z.enum(VACANCY_EDUCATION_LEVELS).nullable().optional(),
  salaryFrom: z.number().min(0).max(9_999_999_999).nullable().optional(),
  salaryTo: z.number().min(0).max(9_999_999_999).nullable().optional(),
  salaryCurrency: z.string().trim().length(3).default('UAH'),
  salaryVisible: z.boolean().default(false),
  assignmentTemplate: vacancyAssignmentTemplateSchema.optional(),
  publicApplyOtp: z.boolean().default(true),
  applyDailyCap: z.number().int().min(10).max(5000).default(200),
  sourceBudget: z.number().min(0).max(9_999_999_999).nullable().optional(),
  languages: z.array(vacancyLanguageSchema).max(10).optional(),
}

/**
 * Создание вакансии (`29` §10 `POST /vacancies`). Вакансия всегда рождается черновиком:
 * состояние меняют отдельные ручки, потому что каждый переход проверяет условия §4 и пишет
 * `audit_log`. `publicToken`, `publicEnabled` и `state` в тело не входят — токен выдаёт
 * сервер при публикации (CLAUDE.md п. 3).
 */
export const vacancyCreateSchema = z.object(vacancyFields).strict()
export type VacancyCreateInput = z.infer<typeof vacancyCreateSchema>

/**
 * Правка (`29` §10 `PATCH /vacancies/:id`). `updatedAt` — оптимистическая блокировка: двое
 * правят одну вакансию, проигравший получает `409` и актуальную версию, а не затирает чужое.
 */
export const vacancyUpdateSchema = vacancyCreateSchema.partial().extend({ updatedAt: z.string().optional() })

export type VacancyUpdateInput = z.infer<typeof vacancyUpdateSchema>

/** Фильтры реестра (`29` §5.1, §10 `GET /vacancies`). */
export const vacancyListSchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    state: z.enum(VACANCY_STATES).optional(),
    locationId: z.string().uuid().optional(),
    orgUnitId: z.string().uuid().optional(),
    recruiterId: z.string().uuid().optional(),
    categoryId: z.string().uuid().optional(),
    courseId: z.string().uuid().optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict()

export type VacancyListFilter = z.infer<typeof vacancyListSchema>

/**
 * Закрытие (`29` §10 `POST /vacancies/:id/close`). Причина обязательна: закрытая без причины
 * вакансия ломает отчёт «Джерела» и не даёт ответить кандидату, который ещё в работе (§4).
 * При `other` нужен текст — иначе `other` становится свалкой.
 */
export const vacancyCloseSchema = z
  .object({
    reason: z.enum(VACANCY_CLOSE_REASONS),
    reasonText: z.string().trim().min(3).max(500).nullable().optional(),
    removeExternal: z.boolean().default(true),
    notifyCandidates: z.boolean().default(false),
  })
  .strict()
  .refine(v => v.reason !== 'other' || !!v.reasonText, { path: ['reasonText'], message: 'Вкажіть причину' })

export type VacancyCloseInput = z.infer<typeof vacancyCloseSchema>

/** Критерий оценки (`29` §10 `POST /vacancies/:id/criteria`, Г-29.5). */
export const vacancyCriterionSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(1000).nullable().optional(),
    weight: z.number().gt(0).max(100).default(1),
    scaleMin: z.number().min(-9999).max(9999).default(0),
    scaleMax: z.number().min(-9999).max(9999).default(5),
    isCritical: z.boolean().default(false),
    origin: z.enum(VACANCY_CRITERION_ORIGINS).default('manual'),
    sort: z.number().int().min(0).max(1000).default(0),
    isActive: z.boolean().default(true),
  })
  .strict()
  .refine(v => v.scaleMax > v.scaleMin, { path: ['scaleMax'], message: 'Максимум шкали має бути більшим за мінімум' })

export type VacancyCriterionInput = z.infer<typeof vacancyCriterionSchema>

/** Правка критерия — те же поля, все необязательные; шкала проверяется сервисом по строке в БД. */
export const vacancyCriterionUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    weight: z.number().gt(0).max(100).optional(),
    scaleMin: z.number().min(-9999).max(9999).optional(),
    scaleMax: z.number().min(-9999).max(9999).optional(),
    isCritical: z.boolean().optional(),
    sort: z.number().int().min(0).max(1000).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()

export type VacancyCriterionUpdateInput = z.infer<typeof vacancyCriterionUpdateSchema>

/**
 * Баллы по критериям (`29` §10 `POST /candidates/:id/criterion-scores`). Приходят пачкой:
 * рекрутер заполняет блок «Оцінка кандидата по критеріях» целиком, а свёртка в
 * `candidate_scores` считается один раз по всей пачке (§3.3, критерий §13 к. 11).
 */
export const vacancyCriterionScoresSchema = z
  .object({
    scores: z
      .array(
        z.object({
          criterionId: z.string().uuid(),
          valueNum: z.number().min(-9999).max(9999),
          comment: z.string().trim().max(1000).nullable().optional(),
        }).strict(),
      )
      .min(1)
      .max(50),
  })
  .strict()

export type VacancyCriterionScoresInput = z.infer<typeof vacancyCriterionScoresSchema>

/** Шаблон вакансии (`29` §3.4, §10 `POST /vacancy-templates`). */
export const vacancyTemplateSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    description: z.string().trim().max(1000).nullable().optional(),
    payload: vacancyCreateSchema.partial().default({}),
    criteria: z.array(vacancyCriterionSchema).max(20).default([]),
    languages: z.array(vacancyLanguageSchema).max(10).default([]),
  })
  .strict()

export type VacancyTemplateInput = z.infer<typeof vacancyTemplateSchema>

/** «Зберегти шаблон» из формы вакансии (`29` §7.21, §10 `POST /vacancy-templates/from-vacancy/:id`). */
export const vacancyTemplateFromVacancySchema = z
  .object({ name: z.string().trim().min(3).max(120), description: z.string().trim().max(1000).nullable().optional() })
  .strict()

export type VacancyTemplateFromVacancyInput = z.infer<typeof vacancyTemplateFromVacancySchema>

/**
 * Применение шаблона (`29` §10 `POST /vacancies/from-template/:tid`). Точка и рекрутер в
 * шаблон не входят (§3.4) и задаются здесь: они не свойство позиции, а свойство конкретного
 * набора.
 */
export const vacancyFromTemplateSchema = z
  .object({
    locationId: z.string().uuid().nullable().optional(),
    recruiterId: z.string().uuid().nullable().optional(),
    title: title.optional(),
  })
  .strict()

export type VacancyFromTemplateInput = z.infer<typeof vacancyFromTemplateSchema>
