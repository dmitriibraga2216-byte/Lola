import { z } from 'zod'
import {
  CANDIDATE_COMMENT_VISIBILITIES, CANDIDATE_REJECT_REASONS, CANDIDATE_SCORE_KINDS,
  CANDIDATE_SOURCES, CANDIDATE_STATES,
} from '../enums'
import { KEYSETS } from '../domain/keyset'
import { keysetCursorSchema } from './keyset'

/**
 * Контракты рекрутинга: кандидат, его карточка, статусы, оценки (docs/v2/28 §6, §10).
 * Один источник для клиента и сервера (CLAUDE.md п. 7).
 */

const name = z.string().trim().min(2).max(60)
/** E.164 — тот же формат, что у сотрудника: кандидат и сотрудник живут в одной таблице. */
const phone = z.string().trim().regex(/^\+\d{8,15}$/)
const email = z.string().trim().email().max(200)

/**
 * Создание кандидата — форма `28` §6.1.
 *
 * Телефон **или** e-mail: линейный персонал часто приходит без почты, а отклик с площадки —
 * без телефона (§6.1). Пустой контакт — `400 candidate.contact_required`, а не «заполните оба».
 *
 * `consentGiven` — не поле таблицы, а подтверждение из формы: сервер сам проставляет
 * `consent_given_at = now()` и `consent_expires_at` (§7.9). Без согласия кандидат не создаётся —
 * это единственная категория людей, которая не подписывала с тенантом ничего другого.
 *
 * `confirmDuplicate` — явное подтверждение после показа найденной карточки (§7.2, критерий §13
 * к. 2): повторный отклик того же человека — норма, а два профиля с разной историей — источник
 * неверных решений, поэтому тихого дубликата быть не должно.
 */
export const candidateCreateSchema = z
  .object({
    firstName: name,
    lastName: name,
    middleName: z.string().trim().max(60).nullable().optional(),
    phone: phone.nullable().optional(),
    email: email.nullable().optional(),
    statusId: z.string().uuid().nullable().optional(),
    /** «Вакансія» формы (`28` §6.1): открытая вакансия точки. Колонка приехала развязкой PR-15. */
    vacancyId: z.string().uuid().nullable().optional(),
    source: z.enum(CANDIDATE_SOURCES).nullable().optional(),
    sourceDetail: z.string().trim().max(200).nullable().optional(),
    recruiterId: z.string().uuid().nullable().optional(),
    accessUntil: z.string().date().nullable().optional(),
    commLanguage: z.string().trim().min(2).max(5).default('uk'),
    resumeAssetId: z.string().uuid().nullable().optional(),
    consentGiven: z.literal(true),
    confirmDuplicate: z.boolean().default(false),
  })
  .strict()

export type CandidateCreateInput = z.infer<typeof candidateCreateSchema>

/**
 * Правка карточки (`28` §10 `PATCH /candidates/:id`). Состояние воронки и колонка канбана
 * сюда не входят: их меняют отдельные ручки, потому что каждая смена пишет историю и
 * проверяет переход (§4.2). `updatedAt` — оптимистическая блокировка (§12.6): два рекрутера
 * двигают одну карточку, проигравший получает `409 conflict` и актуальное состояние.
 */
export const candidateUpdateSchema = z
  .object({
    firstName: name.optional(),
    lastName: name.optional(),
    middleName: z.string().trim().max(60).nullable().optional(),
    phone: phone.nullable().optional(),
    email: email.nullable().optional(),
    vacancyId: z.string().uuid().nullable().optional(),
    source: z.enum(CANDIDATE_SOURCES).nullable().optional(),
    sourceDetail: z.string().trim().max(200).nullable().optional(),
    recruiterId: z.string().uuid().nullable().optional(),
    accessUntil: z.string().date().nullable().optional(),
    commLanguage: z.string().trim().min(2).max(5).optional(),
    resumeAssetId: z.string().uuid().nullable().optional(),
    consentExpiresAt: z.string().date().nullable().optional(),
    updatedAt: z.string().optional(),
  })
  .strict()

export type CandidateUpdateInput = z.infer<typeof candidateUpdateSchema>

/** Фильтры списка и воронки (`28` §5.1, §10 `GET /candidates`). */
export const candidateListSchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    statusId: z.string().uuid().optional(),
    state: z.enum(CANDIDATE_STATES).optional(),
    recruiterId: z.string().uuid().optional(),
    vacancyId: z.string().uuid().optional(),
    source: z.enum(CANDIDATE_SOURCES).optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict()

export type CandidateListFilter = z.infer<typeof candidateListSchema>

/**
 * Смена колонки канбана (`28` §10 `POST /candidates/:id/status`). Переход в колонку, чей
 * `maps_to` отличается от текущего состояния, двигает и ось `candidate_state` — но только
 * по разрешённым переходам §4.2: из `hired` не ведёт ни один (критерий §13 к. 11).
 */
export const candidateStatusMoveSchema = z
  .object({
    statusId: z.string().uuid(),
    reasonCode: z.string().trim().max(60).nullable().optional(),
    reasonText: z.string().trim().max(500).nullable().optional(),
    notify: z.boolean().default(false),
  })
  .strict()

export type CandidateStatusMoveInput = z.infer<typeof candidateStatusMoveSchema>

/**
 * Оценка кандидата (`28` §10 `POST /candidates/:id/scores`). Либо число, либо уровень шкалы —
 * этого же требует `candidate_scores_value_chk`. Вид `ai` руками не ставится: ИИ не принимает
 * решений о людях, а его оценку пишет авто-собеседование (`docs/v2/30`), не человек.
 */
export const candidateScoreSchema = z
  .object({
    kind: z.enum(CANDIDATE_SCORE_KINDS).refine(k => k !== 'ai', { message: 'Оцінку ШІ ставить система' }),
    valueNum: z.number().min(-9999).max(9999).nullable().optional(),
    scaleId: z.string().uuid().nullable().optional(),
    scaleLevelId: z.string().uuid().nullable().optional(),
    comment: z.string().trim().max(2000).nullable().optional(),
    sourceType: z.string().trim().max(40).nullable().optional(),
    sourceId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.valueNum === null || v.valueNum === undefined) {
      if (!v.scaleLevelId) ctx.addIssue({ code: 'custom', path: ['valueNum'], message: 'Вкажіть бал або рівень шкали' })
    }
  })

export type CandidateScoreInput = z.infer<typeof candidateScoreSchema>

/** Комментарий рекрутера (`28` §3.5, §10 `POST /candidates/:id/comments`). */
export const candidateCommentSchema = z
  .object({
    body: z.string().trim().min(1).max(4000),
    visibility: z.enum(CANDIDATE_COMMENT_VISIBILITIES).default('recruiters'),
  })
  .strict()

export type CandidateCommentInput = z.infer<typeof candidateCommentSchema>

/**
 * Найм (`28` §5.5, §7.6, §10 `POST /candidates/:id/hire`).
 *
 * Точка, должность и дата выхода обязательны — это и есть размещение, которое создаётся той же
 * транзакцией (§7.6). Курсы онбординга приходят списком: назначение создаётся обычным
 * `assignments`, своего механизма выдачи у найма нет (инвариант 1, §1 «Границы ответственности»).
 */
export const candidateHireSchema = z
  .object({
    locationId: z.string().uuid(),
    positionId: z.string().uuid(),
    startDate: z.string().date(),
    orgUnitId: z.string().uuid().nullable().optional(),
    positionLevelId: z.string().uuid().nullable().optional(),
    mentorId: z.string().uuid().nullable().optional(),
    onboardingCourseIds: z.array(z.string().uuid()).max(20).default([]),
    welcomeLetter: z.boolean().default(false),
  })
  .strict()

export type CandidateHireInput = z.infer<typeof candidateHireSchema>

/**
 * Отказ (`28` §6.2, §10 `POST /candidates/:id/reject`). Причина обязательна и берётся из
 * закрытого перечня: она уходит в отчёт «Відмови за причинами» (§9 п. 5) и в письмо кандидату,
 * а восстановить её задним числом неоткуда.
 */
export const candidateRejectSchema = z
  .object({
    reasonCode: z.enum(CANDIDATE_REJECT_REASONS),
    reasonText: z.string().trim().max(500).nullable().optional(),
    notify: z.boolean().default(false),
  })
  .strict()

export type CandidateRejectInput = z.infer<typeof candidateRejectSchema>

/** Архивация и самоотвод (`28` §4.2, §10): причина свободным текстом, необязательна. */
export const candidateArchiveSchema = z
  .object({ reasonText: z.string().trim().max(500).nullable().optional() })
  .strict()

export type CandidateArchiveInput = z.infer<typeof candidateArchiveSchema>

/**
 * Повторное открытие (`28` §4.2, §10 `POST /candidates/:id/reopen`). Причина обязательна:
 * возврат в воронку — решение администратора, и оно должно быть объяснено в `audit_log`.
 */
export const candidateReopenSchema = z
  .object({ reasonText: z.string().trim().min(3).max(500) })
  .strict()

export type CandidateReopenInput = z.infer<typeof candidateReopenSchema>

/**
 * Страница колонки канбана (`28` §5.2, §10 `GET /candidates/board`).
 *
 * Доска не грузит колонку целиком: 250 карточек в одной колонке — обычное дело на массовом
 * найме, и это первое место, где страница умирает (§5.2, критерий §13 к. 12). Поэтому
 * `limit` ограничен полусотней, а догрузка идёт курсором по `(created_at, id)`.
 */
export const candidateBoardSchema = z
  .object({
    statusId: z.string().uuid().optional(),
    recruiterId: z.string().uuid().optional(),
    source: z.enum(CANDIDATE_SOURCES).optional(),
    q: z.string().trim().max(200).optional(),
    cursor: keysetCursorSchema(KEYSETS.candidateBoard).optional(), // позиция последней показанной карточки, выдаёт сервер
    limit: z.coerce.number().int().min(1).max(50).default(50),
  })
  .strict()

export type CandidateBoardFilter = z.infer<typeof candidateBoardSchema>

/** Массовая смена колонки (`28` §6.3, §10 `POST /candidates/bulk/status`). */
export const candidateBulkStatusSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(200),
    statusId: z.string().uuid(),
    reasonCode: z.string().trim().max(60).nullable().optional(),
    reasonText: z.string().trim().max(500).nullable().optional(),
    notify: z.boolean().default(false),
  })
  .strict()

export type CandidateBulkStatusInput = z.infer<typeof candidateBulkStatusSchema>

/**
 * Отчёт по воронке (`28` §9 п. 1, §10 `GET /reports/recruiting-funnel`). Фильтры — период,
 * рекрутер, источник; точка и вакансия приедут вместе с `users.vacancy_id` (PR-15).
 */
export const funnelReportSchema = z
  .object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    recruiterId: z.string().uuid().optional(),
    source: z.enum(CANDIDATE_SOURCES).optional(),
    format: z.enum(['json', 'xlsx']).default('json'),
  })
  .strict()

export type FunnelReportFilter = z.infer<typeof funnelReportSchema>

/**
 * Отчёты «Ефективність рекрутера», «Джерела», «Час до найму», «Відмови по причинах»
 * (`28` §9 п. 2–5, PR-38, П-22). Один контракт на все четыре: они читают тот же кандидатопоток,
 * что и воронка, разница только в разрезе группировки на сервере.
 */
export const recruitingReportFilterSchema = z
  .object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    recruiterId: z.string().uuid().optional(),
    source: z.enum(CANDIDATE_SOURCES).optional(),
    vacancyId: z.string().uuid().optional(),
    format: z.enum(['json', 'xlsx']).default('json'),
  })
  .strict()

export type RecruitingReportFilter = z.infer<typeof recruitingReportFilterSchema>

/**
 * Колонка воронки (`28` §3.3, §10 `/candidate-statuses`). `mapsTo` обязателен: колонка без
 * терминального состояния ломает отчётность по воронке, поэтому `422 maps_to.required`
 * появляется здесь, а не в сервисе.
 */
export const candidateStatusCreateSchema = z
  .object({
    code: z.string().trim().min(2).max(40).regex(/^[a-z][a-z0-9_]*$/),
    nameUk: z.string().trim().min(1).max(60),
    nameEn: z.string().trim().min(1).max(60).nullable().optional(),
    color: z.enum(['ink', 'sun', 'teal', 'coral']).default('ink'),
    mapsTo: z.enum(CANDIDATE_STATES),
    sort: z.number().int().min(0).max(999).optional(),
  })
  .strict()

export type CandidateStatusCreateInput = z.infer<typeof candidateStatusCreateSchema>

/** Правка колонки: у системной меняются только название, цвет, порядок и активность (§3.3). */
export const candidateStatusUpdateSchema = z
  .object({
    nameUk: z.string().trim().min(1).max(60).optional(),
    nameEn: z.string().trim().min(1).max(60).nullable().optional(),
    color: z.enum(['ink', 'sun', 'teal', 'coral']).optional(),
    mapsTo: z.enum(CANDIDATE_STATES).optional(),
    sort: z.number().int().min(0).max(999).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()

export type CandidateStatusUpdateInput = z.infer<typeof candidateStatusUpdateSchema>
