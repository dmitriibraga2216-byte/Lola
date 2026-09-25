import { desc, eq, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { savedReports, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { UserKind } from '../../shared/enums'
import { scopeSql } from './access'
import { enqueueNotification } from './notifications'
import { frameFirst, frameJoins, frameKind } from './reportFrame'
import { toXlsx } from './reports'
import { EMPLOYEE } from './repo/people'
import {
  candidateSourcesReport, funnelReport, recruiterEfficiencyReport, rejectionReasonsReport, timeToHireReport,
} from './candidateFunnel'
import { funnelReportSchema, recruitingReportFilterSchema } from '../../shared/schemas/candidates'
import type { FunnelReportFilter, RecruitingReportFilter } from '../../shared/schemas/candidates'
import { contentQualityReport } from './contentQuality'
import { contentQualityQuerySchema } from '../../shared/schemas/contentIssues'
import type { ContentQualityQuery } from '../../shared/schemas/contentIssues'
import { planFactExportRows, timePlanFactReport } from './timeNorms'
import { timePlanFactQuerySchema } from '../../shared/schemas/timeNorms'
import type { TimePlanFactQuery } from '../../shared/schemas/timeNorms'
import { stageSpeedReport } from './lifecycleState'
import { offboardingReasonsReport } from './offboarding'
import { learningActivityReport } from './activity'
import { reportFilterSchema } from '../../shared/schemas/reports'
import type { ReportFilter } from '../../shared/schemas/reports'

interface Ctx { tenantId: string, actorId: string }

/**
 * Описание сущности конструктора. `kind` — обязательное поле (инвариант 17, П-16.1): вид людей
 * в строках называется в описании сущности, а предикат — `frameKind()`, тот же, что `frameWhere()`
 * ставит всем отчётам и журналам, — подставляет `runReport()` в каждый её запрос: в таблицу,
 * группировку, xlsx и отчёт по расписанию. Сущность без `kind` не проходит typecheck.
 *   - `'employee'` — отчёт по штату;
 *   - `'candidate'` — только рекрутинговая сущность: кандидаты видны явно и только там;
 *   - `null` — строки сущности не люди, и `users` в ней не источник строк (разве что
 *     `left join` по первичному ключу ради имени).
 * Итоговый SQL каждой сущности проверяет `tests/unit/report-builder-kind.spec.ts`: `from` живёт
 * в описании, `where` — в `runReport()`, и сканер исходников (`users-kind-filter.spec.ts`) связи
 * между ними не видит. Человек строки — `u` (соглашение каркаса `reportFrame.ts`).
 */
interface EntityDef {
  kind: UserKind | null
  from: SQL
  fields: Record<string, SQL>
  filters: Record<string, SQL>
  /**
   * Колонка, по якій `scopeSql` (в `runReport()`) звужує область видимості; `null` — у сутності
   * немає розрізу «точка» (наприклад, сховище — показник тенанта, не людини), звуження не
   * застосовується (PR-38, П-22): без цього прапорця запит з непорожньою `scope` впав би
   * `pl not found` для сутностей без `frameJoins()`.
   */
  scopeCol: SQL | null
  tenantCol: SQL
}

/**
 * Конструктор сводных отчётов (docs/03 §3.26): сущность → поля → фильтры → группировка,
 * сохранение под именем, расписание с отправкой в Telegram/на почту.
 * Поля — только из белого списка: SQL собирается из известных колонок, не из ввода.
 *
 * Докс/33 D-046: людина у всіх сутностей резолвиться тим самим фрагментом, що й у решти
 * звітів/журналів (`reportFrame.ts#frameJoins` — відкрите основне розміщення через `LATERAL`,
 * а не прямий `JOIN`, тому кілька відкритих `is_primary`-рядків не розмножують результат);
 * `l`/`p`/`ou`/`ci` — аліаси каркаса, `pl` — саме розміщення. Область видимості — той самий
 * `scopeSql`, що й у `reportFrame.ts#frameWhere`. Поля лишились свої — конструктор довільний,
 * каркас дає лише «хто ця людина», не набір колонок.
 *
 * `scopeCol` — колонка, по якій `scopeSql` звужує область видимості; `null` — у сутності немає
 * розрізу «точка» (наприклад, сховище — показник тенанта, не людини), звуження не застосовується
 * (PR-38, П-22): без цього прапорця запит з непорожньою `scope` впав би `pl not found`
 * для сутностей без `frameJoins()`.
 */
export const ENTITIES = {
  people: {
    kind: EMPLOYEE,
    from: sql`users u ${frameJoins()}`,
    fields: {
      full_name: sql`u.full_name`, phone: sql`u.phone`, status: sql`u.status`, hired_at: sql`u.hired_at`, location: sql`l.name`, position: sql`p.name`,
      courses_done: sql`(select count(*) from enrollments e where e.user_id = u.id and e.status = 'done' and e.cancelled_at is null)`,
      courses_overdue: sql`(select count(*) from enrollments e where e.user_id = u.id and e.cancelled_at is null and e.status in ('not_started','in_progress') and e.due_at < now())`,
    },
    filters: { location_id: sql`pl.location_id`, position_id: sql`pl.position_id`, status: sql`u.status`, hired_from: sql`u.hired_at`, hired_to: sql`u.hired_at` },
    scopeCol: sql`pl.location_id`,
    tenantCol: sql`u.tenant_id`,
  },
  enrollments: {
    kind: EMPLOYEE,
    from: sql`enrollments e join users u on u.id = e.user_id join courses c on c.id = e.subject_id ${frameJoins()}`,
    // Пять статусов + признаки: overdue (due_at < now при незавершённом), cancelled_at (снято)
    fields: { full_name: sql`u.full_name`, course: sql`c.title`, status: sql`e.status`, overdue: sql`(e.cancelled_at is null and e.status in ('not_started','in_progress') and e.due_at < now())`, cancelled_at: sql`e.cancelled_at`, progress_pct: sql`e.progress_pct`, due_at: sql`e.due_at`, completed_at: sql`e.completed_at`, location: sql`l.name`, source: sql`e.source` },
    filters: { location_id: sql`pl.location_id`, course_id: sql`e.subject_id`, status: sql`e.status`, due_from: sql`e.due_at`, due_to: sql`e.due_at` },
    scopeCol: sql`pl.location_id`,
    tenantCol: sql`e.tenant_id`,
  },
  attempts: {
    kind: EMPLOYEE,
    from: sql`attempts a join users u on u.id = a.user_id join quizzes q on q.id = a.quiz_id ${frameJoins()}`,
    // «Кінець» спроби — `submitted_at`: колонки `attempts.finished_at` нет и не было, поле падало
    // ошибкой SQL. Ключ поля прежний — его называют сохранённые отчёты.
    fields: { full_name: sql`u.full_name`, quiz: sql`q.title`, attempt_no: sql`a.attempt_no`, status: sql`a.status`, score: sql`a.score`, passed: sql`a.passed`, started_at: sql`a.started_at`, finished_at: sql`a.submitted_at`, location: sql`l.name` },
    filters: { location_id: sql`pl.location_id`, quiz_id: sql`a.quiz_id`, status: sql`a.status`, from: sql`a.started_at`, to: sql`a.started_at` },
    scopeCol: sql`pl.location_id`,
    tenantCol: sql`a.tenant_id`,
  },
  /**
   * «Люди по этапам» (`33` §9 п. 1, PR-38, П-22): строка — поточний етап людини
   * (`employee_lifecycle_state.is_current`). Тільки співробітники — кандидатський етап (якщо
   * колись буде) тут не рахується; вид — полем `kind`, як у трьох сутностей вище (PR-141),
   * а не власним підзапитом до `users` (`frameKind()` в `runReport()` ставить `and u.kind = …`
   * сама, тож другий фільтр у `from` був би зайвим дублюванням).
   */
  stages: {
    kind: EMPLOYEE,
    from: sql`users u
      join employee_lifecycle_state els on els.user_id = u.id and els.is_current
      join lifecycle_stages ls on ls.id = els.stage_id
      ${frameJoins()}`,
    fields: {
      full_name: sql`u.full_name`, location: sql`l.name`, position: sql`p.name`, unit: sql`ou.name`,
      stage: sql`ls.name_uk`, stage_code: sql`ls.code`,
      entered_at: sql`els.entered_at`,
      days_in_stage: sql`extract(day from (now() - els.entered_at))::int`,
      expected_days: sql`ls.expected_days`,
      exceeded: sql`(ls.expected_days is not null and extract(day from (now() - els.entered_at)) > ls.expected_days)`,
    },
    filters: { location_id: sql`pl.location_id`, position_id: sql`pl.position_id`, org_unit_id: sql`ou.id`, stage_code: sql`ls.code`, entered_from: sql`els.entered_at`, entered_to: sql`els.entered_at` },
    scopeCol: sql`pl.location_id`,
    tenantCol: sql`u.tenant_id`,
  },
  /**
   * «Робота перевіряючих» (`37` §9 п. 2, PR-38, П-22, `⟵` PR-19): строка — проверяющий за
   * сутки, джерело `reviewer_stats_daily`. Без «догрузки поточної доби» (§9.2) — конструктор
   * читає вже закриті добові зрізи, як і решта звітів каркаса; за сьогодні цифра з'явиться
   * після нічного `review.stats_rollup`.
   */
  reviewers: {
    kind: EMPLOYEE,
    from: sql`reviewer_stats_daily rs left join users u on u.id = rs.reviewer_id ${frameJoins()}`,
    fields: {
      reviewer: sql`u.full_name`, location: sql`l.name`, day: sql`rs.day`,
      reviewed: sql`rs.reviewed_count`, accepted: sql`rs.accepted_count`, rejected: sql`rs.rejected_count`, rework: sql`rs.rework_count`,
      delegated_out: sql`rs.delegated_out`, delegated_in: sql`rs.delegated_in`, breached: sql`rs.breached_count`, own_content: sql`rs.own_content_count`,
      median_react_sec: sql`rs.median_react_sec`, median_review_sec: sql`rs.median_review_sec`,
    },
    filters: { reviewer_id: sql`rs.reviewer_id`, location_id: sql`pl.location_id`, day_from: sql`rs.day`, day_to: sql`rs.day` },
    scopeCol: sql`pl.location_id`,
    tenantCol: sql`rs.tenant_id`,
  },
  /**
   * «Укомплектованість структури» (`32` §9, PR-38, П-22). Строка — вузол дерева підпорядкування
   * (`org_nodes`), не людина: «Факт»/«Вакансій» — з `org_node_assignments`, а не з кешу
   * `holder_user_id` (він — для одного тримача, а вузол-посада тримає декількох, `headcount_planned`).
   * **`holder`** — тримач вузла напряму (`left join users` по первичному ключу — enrichment,
   * не «список людей», сканер П-16.1 це визнає), **не** `resolveManager()`: колонка «Керівник»
   * доку читається як «хто зараз тримає цей вузол», а не «хто над ним» — читати
   * `org_manager_map`/`locations.manager_id` напряму для «хто над людиною» заборонено (сквозная
   * проверка 9), і цей звіт цього не робить.
   */
  orgNodes: {
    // `null` — рядок не людина (вузол дерева); `holder` — enrichment по первичному ключу, не вибірка людей.
    kind: null,
    from: sql`org_nodes n
      left join positions p on p.id = n.position_id
      left join org_units ou on ou.id = n.org_unit_id
      left join locations l on l.id = n.location_id
      left join users hu on hu.id = n.holder_user_id`,
    fields: {
      node: sql`n.title`, location: sql`l.name`, org_unit: sql`ou.name`, position: sql`p.name`,
      headcount_planned: sql`n.headcount_planned`,
      occupied: sql`(select count(*)::int from org_node_assignments a where a.node_id = n.id and a.ended_at is null)`,
      vacancies: sql`greatest(n.headcount_planned - (select count(*)::int from org_node_assignments a where a.node_id = n.id and a.ended_at is null), 0)`,
      holder: sql`hu.full_name`,
      state: sql`n.state`,
      type: sql`n.type`,
    },
    filters: { location_id: sql`n.location_id`, org_unit_id: sql`n.org_unit_id`, state: sql`n.state`, type: sql`n.type` },
    scopeCol: sql`n.location_id`,
    tenantCol: sql`n.tenant_id`,
  },
  /**
   * «Динаміка сховища» (`34` §9, PR-38, П-22): строка — тенант/день/походження, з
   * `storage_usage_daily`. Людей у показнику немає — область видимості за точкою не
   * застосовується (`scopeCol: null`), тенантну межу тримає RLS. `drift_bytes` навмисно не
   * винесений полем: доку він «видно тільки admin і оператору», а конструктор доступний
   * ширшому колу `report.builder` — колонки просто немає в білому списку.
   */
  storage: {
    kind: null,
    from: sql`storage_usage_daily`,
    fields: { day: sql`day`, origin: sql`origin`, stage_code: sql`stage_code`, bytes: sql`bytes`, files_count: sql`files_count` },
    filters: { origin: sql`origin`, stage_code: sql`stage_code`, day_from: sql`day`, day_to: sql`day` },
    scopeCol: null,
    tenantCol: sql`tenant_id`,
  },
  /**
   * «Норми і залишки відсутностей» (`38` §9 п. 3, PR-38, П-22, `⟵` PR-33/39). Норма — той самий
   * пріоритет, що й `resolveAbsenceNorms()` (людина → точка → компанія → системний дефолт),
   * тільки одним корельованим підзапитом на людину замість виклику функції в циклі (звіт, а не
   * картка однієї людини). Рік — поточний за UTC: наближення проти `currentYear()` (пояс
   * тенанта), прийнятне для довідкового звіту-вигрузки, не для картки людини.
   */
  absences: {
    kind: EMPLOYEE,
    from: sql`users u ${frameJoins()}`,
    fields: {
      full_name: sql`u.full_name`, location: sql`l.name`,
      vacation_norm: sql`coalesce(
        (select vacation_days from absence_norms where tenant_id = u.tenant_id and scope_type = 'user' and scope_id = u.id and year = extract(year from now())::int and vacation_days is not null),
        (select vacation_days from absence_norms where tenant_id = u.tenant_id and scope_type = 'location' and scope_id = pl.location_id and year = extract(year from now())::int and vacation_days is not null),
        (select vacation_days from absence_norms where tenant_id = u.tenant_id and scope_type = 'tenant' and scope_id is null and year = extract(year from now())::int and vacation_days is not null),
        24)`,
      vacation_source: sql`case
        when exists (select 1 from absence_norms where tenant_id = u.tenant_id and scope_type = 'user' and scope_id = u.id and year = extract(year from now())::int and vacation_days is not null) then 'user'
        when exists (select 1 from absence_norms where tenant_id = u.tenant_id and scope_type = 'location' and scope_id = pl.location_id and year = extract(year from now())::int and vacation_days is not null) then 'location'
        when exists (select 1 from absence_norms where tenant_id = u.tenant_id and scope_type = 'tenant' and scope_id is null and year = extract(year from now())::int and vacation_days is not null) then 'tenant'
        else 'system' end`,
      vacation_used: sql`coalesce((select sum(days_count) from absence_records where user_id = u.id and kind = 'vacation' and status = 'approved' and extract(year from date_from) = extract(year from now())), 0)`,
      sick_norm: sql`coalesce(
        (select sick_days from absence_norms where tenant_id = u.tenant_id and scope_type = 'user' and scope_id = u.id and year = extract(year from now())::int and sick_days is not null),
        (select sick_days from absence_norms where tenant_id = u.tenant_id and scope_type = 'location' and scope_id = pl.location_id and year = extract(year from now())::int and sick_days is not null),
        (select sick_days from absence_norms where tenant_id = u.tenant_id and scope_type = 'tenant' and scope_id is null and year = extract(year from now())::int and sick_days is not null),
        5)`,
      sick_used: sql`coalesce((select sum(days_count) from absence_records where user_id = u.id and kind = 'sick' and status = 'approved' and extract(year from date_from) = extract(year from now())), 0)`,
    },
    filters: { location_id: sql`pl.location_id` },
    scopeCol: sql`pl.location_id`,
    tenantCol: sql`u.tenant_id`,
  },
} as const satisfies Record<string, EntityDef>

export type Entity = keyof typeof ENTITIES

/**
 * Готові звіти пакету (PR-38, П-22): агрегати, які не лягають у пласку модель «поля з таблиці»
 * (перцентилі, конверсії, нормалізація на 100 проходжень) або вже мають власний сервіс —
 * `funnelReport`/`contentQualityReport`/`timePlanFactReport` (PR-14, PR-24, PR-22). Тут вони
 * лише реєструються для конструктора: `run()` викликає той самий сервіс, що й власна ручка
 * звіту, і повертає рядки в тому ж вигляді, що вивантаження екрана — жодної другої копії
 * розрахунку. Групування (`spec.groupBy`) для них не застосовується: кожен рядок уже є groupom
 * свого природного розрізу (рекрутер, джерело, вакансія, причина, етап…).
 */
interface FixedReportDef { fields: string[], filters: string[], run: (ctx: Ctx, filters: Record<string, unknown>, scope: string[] | null) => Promise<Record<string, unknown>[]> }

/**
 * `schema` типізовано структурно, а не через `z.ZodType<T>`: у `ZodType<Output, Def, Input>`
 * `Input` і `Output` — різні типи для будь-якої схеми з `.default()`/`.transform()` (усі наші
 * фільтри такі — `format` за замовчуванням, `tags` приймає рядок або масив), а `z.ZodType<T>`
 * зводить обидва до одного `T` і псує висновок типу то в один, то в інший бік (форматом
 * необов'язковим на виході або вхідним типом `tags`, що не збігається з вихідним). Метод
 * `safeParse()` в самому Zod бере `unknown` і повертає `data: Output` — точнісінько це й описано
 * нижче, без другого (вхідного) боку. Виклик — завжди з явним `T` (`parseOr<X>(schema, …)`):
 * коли `T` не вказано явно, той самий висновок типу намагається вивести його одразу і зі
 * `schema`, і з `fallback`, і для деяких схем це давало ту ж плутанину.
 */
function parseOr<T>(schema: { safeParse: (v: unknown) => { success: true, data: T } | { success: false } }, input: Record<string, unknown>, fallback: T): T {
  const p = schema.safeParse({ ...input, format: 'json' })
  return p.success ? p.data : fallback
}

export const FIXED_REPORTS: Record<string, FixedReportDef> = {
  /** «Воронка найму» (`28` §9 п. 1, вже PR-14) — рядки таблиці етапів, не список людей екрана. */
  'recruiting-funnel': {
    fields: ['status', 'entered', 'current', 'share_pct', 'avg_days', 'to_next_pct'],
    filters: ['recruiterId', 'source', 'from', 'to'],
    run: async (ctx, filters, scope) => {
      const f = parseOr<FunnelReportFilter>(funnelReportSchema, filters, { format: 'json' })
      const r = await funnelReport({ tenantId: ctx.tenantId, actorId: ctx.actorId, locations: scope, fullPd: false, reviewOnly: false }, f)
      return r.stages.map(s => ({ status: s.nameUk, entered: s.entered, current: s.current, share_pct: s.sharePct, avg_days: s.avgDays, to_next_pct: s.toNextPct }))
    },
  },
  'recruiter-efficiency': {
    fields: ['recruiter', 'added', 'in_progress', 'on_review', 'hired', 'rejected', 'archived', 'avg_days_to_decision', 'hire_share_pct'],
    filters: ['recruiterId', 'source', 'vacancyId', 'from', 'to'],
    run: async (ctx, filters, scope) => {
      const f = parseOr<RecruitingReportFilter>(recruitingReportFilterSchema, filters, { format: 'json' })
      const rows = await recruiterEfficiencyReport({ tenantId: ctx.tenantId, actorId: ctx.actorId, locations: scope }, f)
      return rows.map(r => ({ recruiter: r.recruiter, added: r.added, in_progress: r.inProgress, on_review: r.onReview, hired: r.hired, rejected: r.rejected, archived: r.archived, avg_days_to_decision: r.avgDaysToDecision, hire_share_pct: r.hireSharePct }))
    },
  },
  'candidate-sources': {
    fields: ['source', 'candidates', 'reached_final', 'hired', 'avg_budget'],
    filters: ['recruiterId', 'source', 'vacancyId', 'from', 'to'],
    run: async (ctx, filters, scope) => {
      const f = parseOr<RecruitingReportFilter>(recruitingReportFilterSchema, filters, { format: 'json' })
      const rows = await candidateSourcesReport({ tenantId: ctx.tenantId, actorId: ctx.actorId, locations: scope }, f)
      return rows.map(r => ({ source: r.source, candidates: r.candidates, reached_final: r.reachedFinal, hired: r.hired, avg_budget: r.avgBudget }))
    },
  },
  'time-to-hire': {
    fields: ['vacancy', 'location', 'hired', 'median_days', 'p90_days'],
    filters: ['recruiterId', 'source', 'vacancyId', 'from', 'to'],
    run: async (ctx, filters, scope) => {
      const f = parseOr<RecruitingReportFilter>(recruitingReportFilterSchema, filters, { format: 'json' })
      const rows = await timeToHireReport({ tenantId: ctx.tenantId, actorId: ctx.actorId, locations: scope }, f)
      return rows.map(r => ({ vacancy: r.vacancy, location: r.location, hired: r.hired, median_days: r.medianDays, p90_days: r.p90Days }))
    },
  },
  'rejection-reasons': {
    fields: ['reason_code', 'vacancy', 'count', 'share_pct'],
    filters: ['recruiterId', 'source', 'vacancyId', 'from', 'to'],
    run: async (ctx, filters, scope) => {
      const f = parseOr<RecruitingReportFilter>(recruitingReportFilterSchema, filters, { format: 'json' })
      const rows = await rejectionReasonsReport({ tenantId: ctx.tenantId, actorId: ctx.actorId, locations: scope }, f)
      return rows.map(r => ({ reason_code: r.reasonCode, vacancy: r.vacancy, count: r.count, share_pct: r.sharePct }))
    },
  },
  'stage-speed': {
    fields: ['stage', 'expected_days', 'n', 'median_days', 'p90_days', 'exceeded_share_pct'],
    filters: ['stageCode', 'from', 'to', 'locationId'],
    run: async (ctx, filters, scope) => {
      const f = parseOr<ReportFilter>(reportFilterSchema, filters, {})
      const rows = await stageSpeedReport({ tenantId: ctx.tenantId, actorId: ctx.actorId, scope }, { ...f, stageCode: filters.stageCode as string | undefined })
      return rows.map(r => ({ stage: r.stage, expected_days: r.expectedDays, n: r.n, median_days: r.medianDays, p90_days: r.p90Days, exceeded_share_pct: r.exceededSharePct }))
    },
  },
  'offboarding-reasons': {
    fields: ['reason_code', 'tenure_bucket', 'n', 'share_pct', 'avg_tenure_days', 'interview_done_share_pct'],
    filters: ['locationId', 'from', 'to'],
    run: async (ctx, filters) => {
      const f = parseOr<ReportFilter>(reportFilterSchema, filters, {})
      const rows = await offboardingReasonsReport(ctx, f)
      return rows.map(r => ({ reason_code: r.reasonCode, tenure_bucket: r.tenureBucket, n: r.n, share_pct: r.sharePct, avg_tenure_days: r.avgTenureDays, interview_done_share_pct: r.interviewDoneSharePct }))
    },
  },
  'learning-activity': {
    fields: ['full_name', 'position', 'city', 'unit', 'tags', 'days_active', 'total_events', 'hours', 'longest_streak'],
    filters: ['locationId', 'positionIds', 'orgUnitId', 'from', 'to'],
    run: async (ctx, filters, scope) => {
      const f = parseOr<ReportFilter>(reportFilterSchema, filters, {})
      const rows = await learningActivityReport({ tenantId: ctx.tenantId, actorId: ctx.actorId, scope }, f)
      return frameFirst(rows)
    },
  },
  /** «Якість контенту» (`36` §9, вже PR-24) — та ж вибірка й ті ж імена колонок, що й у вивантаженні екрана. */
  'content-quality': {
    fields: ['element', 'type', 'tracks', 'authors', 'passes', 'complaints', 'per100', 'confirmed', 'rejected', 'avg_days_to_fix', 'open_now'],
    filters: ['from', 'to', 'categoryId', 'authorId', 'issueType', 'targetType', 'locationId'],
    run: async (ctx, filters, scope) => {
      const f = parseOr<ContentQualityQuery>(contentQualityQuerySchema, filters, { format: 'json', groupBy: 'element' })
      const r = await contentQualityReport({ tenantId: ctx.tenantId, actorId: ctx.actorId, scope }, f)
      return r.rows.map(x => ({
        element: x.title, type: x.targetType, tracks: x.tracks.map(t => t.title).join(', '), authors: x.authors.join(', '),
        passes: x.passes, complaints: x.complaints, per100: x.per100, confirmed: x.confirmed, rejected: x.rejected,
        avg_days_to_fix: x.avgDaysToFix, open_now: x.openNow,
      }))
    },
  },
  /**
   * «План і факт часу» (`docs/22` §4.6, `37` §9.3, вже PR-22) — **без жодного поля людини**
   * (`37` §13 к. 11): `planFactExportRows()` — та ж функція, що вже живить xlsx екрана, тут
   * додаткової мапи немає навмисно, щоб конструктор не міг «домалювати» ім'я поверх неї.
   */
  'time-plan-fact': {
    fields: ['element', 'type', 'track', 'planned_min', 'source', 'median_min', 'p25_min', 'p75_min', 'sample', 'deviation', 'factor', 'unreliable_share'],
    filters: ['subjectType', 'trackId', 'deviation', 'minSample', 'from', 'to', 'locationId'],
    run: async (ctx, filters, scope) => {
      const f = parseOr<TimePlanFactQuery>(timePlanFactQuerySchema, filters, { format: 'json' })
      const r = await timePlanFactReport({ tenantId: ctx.tenantId, actorId: ctx.actorId, scope }, f)
      return planFactExportRows(r)
    },
  },
}

export function describeEntities() {
  const plain = Object.fromEntries(Object.entries(ENTITIES).map(([k, v]) => [k, { fields: Object.keys(v.fields), filters: Object.keys(v.filters) }]))
  const fixed = Object.fromEntries(Object.entries(FIXED_REPORTS).map(([k, v]) => [k, { fields: v.fields, filters: v.filters }]))
  return { ...plain, ...fixed }
}

export interface ReportSpec { entity: string, fields: string[], filters?: Record<string, unknown>, groupBy?: string | null }

/**
 * Выполнение: при groupBy — количество строк и средние по числовым полям в группе.
 * `rating_pct` (PR-35) навмисно немає в жодному білому списку полів вище: коли колонка
 * з'явиться на `users`, вона не потрапить у вигрузку жодного з цих звітів сама — її додавання
 * в конкретну сутність буде окремим, видимим рішенням, а не побічним ефектом `select u.*`
 * (тут його й немає — кожна сутність називає свої колонки поіменно).
 */
export async function runReport(ctx: Ctx, spec: ReportSpec, limit = 2000, scope: string[] | null = null): Promise<Record<string, unknown>[]> {
  const fixed = FIXED_REPORTS[spec.entity]
  if (fixed) {
    const rows = await fixed.run(ctx, spec.filters ?? {}, scope)
    const fields = spec.fields.filter(f => fixed.fields.includes(f))
    const picked = fields.length ? rows.map(r => Object.fromEntries(fields.map(f => [f, r[f]]))) : rows
    return picked.slice(0, limit)
  }
  const ent = ENTITIES[spec.entity as Entity]
  if (!ent) return []
  const fields = spec.fields.filter(f => f in ent.fields)
  if (!fields.length) return []
  const where: ReturnType<typeof sql>[] = []
  // Вид людей (инвариант 17) — первым условием и из описания сущности, а не из запроса: ни забыть
  // его в новой сущности, ни снять фильтром нельзя.
  if (ent.kind) where.push(sql`true ${frameKind(ent.kind)}`)
  for (const [k, v] of Object.entries(spec.filters ?? {})) {
    if (v === undefined || v === null || v === '' || !(k in ent.filters)) continue
    const col = (ent.filters as Record<string, ReturnType<typeof sql>>)[k]!
    if (k.endsWith('_from') || k === 'from') where.push(sql`${col} >= ${String(v)}::timestamptz`)
    else if (k.endsWith('_to') || k === 'to') where.push(sql`${col} < (${String(v)}::date + 1)`)
    else if (Array.isArray(v)) where.push(sql`${col}::text in (${sql.join(v.map(x => sql`${String(x)}`), sql`, `)})`)
    else where.push(sql`${col}::text = ${String(v)}`)
  }
  // Область видимости (docs/22 §7.1): применяется до фильтров, расширить параметром нельзя;
  // тот же `scopeSql`, что и в reportFrame.ts#frameWhere. `scopeCol: null` (PR-38) — у сутності
  // немає розрізу «точка», звуження не застосовується (див. коментар над `storage`).
  const scopeCol = (ent as { scopeCol?: ReturnType<typeof sql> | null }).scopeCol
  if (scope !== null && scopeCol) where.push(sql`true ${scopeSql(scope, scopeCol)}`)
  const whereSql = where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const F = ent.fields as Record<string, ReturnType<typeof sql>>
    if (spec.groupBy && spec.groupBy in ent.fields) {
      const g = F[spec.groupBy]!
      const numeric = fields.filter(f => f !== spec.groupBy && /(_pct|score|_done|_overdue|attempt_no)$/.test(f))
      const aggs = numeric.map(f => sql`round(avg((${F[f]!})::numeric), 2) as ${sql.identifier(`avg_${f}`)}`)
      return tx.execute(sql`select ${g} as ${sql.identifier(spec.groupBy)}, count(*)::int as rows${aggs.length ? sql`, ${sql.join(aggs, sql`, `)}` : sql``} from ${ent.from} ${whereSql} group by 1 order by 2 desc limit ${limit}`) as unknown as Record<string, unknown>[]
    }
    const cols = fields.map(f => sql`${F[f]!} as ${sql.identifier(f)}`)
    return tx.execute(sql`select ${sql.join(cols, sql`, `)} from ${ent.from} ${whereSql} order by 1 limit ${limit}`) as unknown as Record<string, unknown>[]
  })
}

export async function listSaved(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => tx.select({ id: savedReports.id, name: savedReports.name, entity: savedReports.entity, fields: savedReports.fields, filters: savedReports.filters, groupBy: savedReports.groupBy, schedule: savedReports.schedule, lastRunAt: savedReports.lastRunAt, createdAt: savedReports.createdAt, author: users.fullName })
    .from(savedReports).leftJoin(users, eq(users.id, savedReports.createdBy)).orderBy(desc(savedReports.createdAt)))
}

export interface Schedule { every: 'daily' | 'weekly', hour: number, weekday?: number, channel: 'telegram' | 'email', recipients: string[] }

export async function saveReport(ctx: Ctx, input: { id?: string, name: string, spec: ReportSpec, schedule?: Schedule | null }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const values = { name: input.name, entity: input.spec.entity, fields: input.spec.fields, filters: input.spec.filters ?? {}, groupBy: input.spec.groupBy ?? null, schedule: input.schedule ?? null }
    if (input.id) {
      const [r] = await tx.update(savedReports).set({ ...values, updatedAt: new Date() }).where(eq(savedReports.id, input.id)).returning()
      return r ?? null
    }
    const [r] = await tx.insert(savedReports).values({ tenantId: ctx.tenantId, createdBy: ctx.actorId, ...values }).returning()
    return r!
  })
}

export async function deleteSaved(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => (await tx.delete(savedReports).where(eq(savedReports.id, id)).returning({ id: savedReports.id })).length > 0)
}

export async function savedToXlsx(ctx: Ctx, id: string, scope: string[] | null = null): Promise<{ name: string, buffer: Buffer } | null> {
  const [r] = await withTenant(ctx.tenantId, ctx.actorId, tx => tx.select().from(savedReports).where(eq(savedReports.id, id)))
  if (!r) return null
  const rows = await runReport(ctx, { entity: r.entity, fields: r.fields, filters: r.filters as Record<string, unknown>, groupBy: r.groupBy }, 2000, scope)
  return { name: r.name, buffer: await toXlsx(r.name, rows as never) }
}

/** Ежечасно: отчёты по расписанию — получателям уходит уведомление со сводкой и ссылкой на xlsx. */
export async function scheduledReportsScan(tenantId: string, now = new Date()): Promise<number> {
  const kyivHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: 'numeric', hour12: false }).format(now))
  const kyivWeekday = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' })).getDay()
  const day = now.toISOString().slice(0, 10)
  let n = 0
  const reports = await withTenant(tenantId, null, tx => tx.select().from(savedReports).where(sql`${savedReports.schedule} is not null`))
  for (const r of reports) {
    const s = r.schedule as Schedule
    if (s.hour !== kyivHour) continue
    if (s.every === 'weekly' && (s.weekday ?? 1) !== kyivWeekday) continue
    if (r.lastRunAt && r.lastRunAt.toISOString().slice(0, 10) === day) continue
    const rows = await runReport({ tenantId, actorId: r.createdBy ?? '' }, { entity: r.entity, fields: r.fields, filters: r.filters as Record<string, unknown>, groupBy: r.groupBy }, 50)
    await withTenant(tenantId, null, async (tx) => {
      for (const uid of s.recipients) {
        await enqueueNotification(tx, { tenantId, userId: uid, code: 'scheduled_report', channel: s.channel, payload: { name: r.name, rows: rows.length, url: `/admin/reports/builder?saved=${r.id}` }, dedupKey: `rep:${r.id}:${uid}:${day}` })
      }
      await tx.update(savedReports).set({ lastRunAt: now }).where(eq(savedReports.id, r.id))
    })
    n++
  }
  return n
}
