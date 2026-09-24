import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { contentTimeNorms } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recipientLocale } from '../utils/formatLocale'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { authorIdsSql, uuidArray } from './contentIssueRouting'
import { frameJoins, frameWhere, periodSql } from './reportFrame'
import { ACTIVE_EMPLOYEES_ONLY } from './repo/people'
import { MANUAL_KINDS } from '../../shared/domain/grading'
import { formatNumber } from '../../shared/domain/dateFormat'
import {
  appliedObservedSeconds, authorSecondsValid, autoMediaSeconds, autoQuizSeconds, autoTextSeconds, canApplyObserved,
  clampNorm, comparePlanFact, deviationFactor, deviationFlag, deviationNoticeDue, observedShown, plannedSeconds, wholeMinutes,
} from '../../shared/domain/timeNorms'
import type { NormValues } from '../../shared/domain/timeNorms'
import type { ContentTimeDeviationFlag, ContentTimeNormSource, LearningTimeSubjectType } from '../../shared/enums'
import type {
  TimeNorm, TimeNormPut, TimePlanFactQuery, TimePlanFactReport, TimePlanFactRow, TimePlanFactTrack,
} from '../../shared/schemas/timeNorms'

/**
 * Нормы времени на контент (docs/v2/37-review-delegation.md §3.5, §6.3, §7.13–7.15, §8, §9.3,
 * §11; PR-22). Единственный писатель `content_time_norms`.
 *
 * **Что здесь есть.** Норма элемента и её источник (форма §6.3, «Застосувати»); снимок нормы
 * для очереди проверки (`plannedSecondsFor()` → `review_queue_items.estimated_seconds` в момент
 * сдачи); еженедельный `time.norms_recalc` — медиана, p25, p75 и размер выборки факта, флаг
 * отклонения и уведомление автору; обезличенный отчёт «План і факт часу».
 *
 * **Чего здесь нет и не будет — ни одного человека.** Факт — агрегат по элементу: медиана
 * `content_seconds + attempt_seconds` достоверных завершённых прохождений из витрины
 * `learning_time_totals`. Витрину и колонки учёта пишет только свёртка `time.rollup`
 * (`learningTimeRollup.ts`, одиннадцатая сквозная проверка) — здесь они только читаются.
 * Флаг отклонения — **сигнал качества материала, а не оценка человека** (§7.14): он не
 * пишется ни в балл, ни в зачёт, ни в рейтинг, ни в начисление баллов, и этот модуль не
 * трогает ни одной таблицы результатов (тринадцатая сквозная проверка, критерий 11).
 *
 * **Одна формула на двоих.** Норма (`time.norms_recalc`) и отчёт считают факт одной функцией
 * `observedStats()` на едином каркасе отчётов (docs/22 §13.3, `reportFrame.ts`): люди —
 * только сотрудники (П-16.1), архивированные исключены (docs/22 §7.5). Норма — это отчёт по
 * всему тенанту с фильтрами по умолчанию; отчёт руководителя точки — тот же расчёт по его
 * области видимости.
 */

export interface Ctx { tenantId: string, actorId: string }
export interface Viewer extends Ctx { scope: string[] | null }

interface Subject { subjectType: LearningTimeSubjectType, subjectId: string }
const keyOf = (s: Subject) => `${s.subjectType}:${s.subjectId}`

// ── Элементы: название, треки, «Орієнтовний час» материала, авторасчёт ─────────────────

interface ElementMeta {
  title: string
  tracks: TimePlanFactTrack[]
  /** Удалённый тест или практикум: строки отчёта нет, норму не задать. */
  deleted: boolean
  /** «Орієнтовний час» материала урока (`resources.estimated_minutes`, `11` §3.1), секунды. */
  authorEstimate: number | null
  /** Расчёт по объёму (§7.13); у практикума и шага траектории — null. */
  autoSeconds: number | null
}

const MANUAL = sql.raw([...MANUAL_KINDS].map(k => `'${k}'`).join(', '))

/** Курсы, в которых стоит тест или практикум: уроки любых версий, курс не удалён. */
async function courseTracks(tx: TenantTx, itemType: 'quiz' | 'workshop', ids: string[]): Promise<Map<string, TimePlanFactTrack[]>> {
  const rows = await tx.execute(sql`
    select distinct l.item_id as element_id, c.id, c.title
      from lessons l
      join modules m on m.id = l.module_id
      join course_versions cv on cv.id = m.course_version_id
      join courses c on c.id = cv.course_id and c.deleted_at is null
     where l.item_type = ${itemType} and l.item_id = any(${uuidArray(ids)})
     order by c.title`) as unknown as { element_id: string, id: string, title: string }[]
  const out = new Map<string, TimePlanFactTrack[]>()
  for (const r of rows) out.set(r.element_id, [...(out.get(r.element_id) ?? []), { id: r.id, title: r.title }])
  return out
}

/** Сведения об элементах пачкой: по запросу на тип, а не на элемент. */
async function elementsMeta(tx: TenantTx, subjects: Subject[]): Promise<Map<string, ElementMeta>> {
  const out = new Map<string, ElementMeta>()
  const idsOf = (t: LearningTimeSubjectType) => [...new Set(subjects.filter(s => s.subjectType === t).map(s => s.subjectId))]

  const lessonIds = idsOf('lesson')
  if (lessonIds.length) {
    // Урок читается в той версии материала, что закреплена публикацией курса (Г-11.3)
    const rows = await tx.execute(sql`
      select l.id, l.title, l.item_type, c.id as course_id, c.title as course_title,
             coalesce(rv.kind, r.kind) as resource_kind, r.estimated_minutes,
             char_length(coalesce(rv.plain_text, r.plain_text, '')) as chars,
             ma.kind as media_kind, ma.duration_sec
        from lessons l
        join modules m on m.id = l.module_id
        join course_versions cv on cv.id = m.course_version_id
        join courses c on c.id = cv.course_id
        left join resources r on l.item_type = 'resource' and r.id = l.item_id
        left join resource_versions rv on rv.id = l.resource_version_id
        left join media_assets ma on ma.id = coalesce(rv.media_id, r.media_id)
       where l.id = any(${uuidArray(lessonIds)})`) as unknown as {
      id: string, title: string, item_type: string, course_id: string, course_title: string, resource_kind: string | null,
      estimated_minutes: number | null, chars: number, media_kind: string | null, duration_sec: number | null
    }[]
    for (const r of rows) {
      let auto: number | null = null
      if (r.item_type === 'resource') {
        if (r.resource_kind === 'article') auto = autoTextSeconds(Number(r.chars))
        else if (r.resource_kind === 'video' || (r.resource_kind === 'file' && (r.media_kind === 'video' || r.media_kind === 'audio'))) auto = autoMediaSeconds(r.duration_sec)
      }
      out.set(keyOf({ subjectType: 'lesson', subjectId: r.id }), {
        title: r.title,
        tracks: [{ id: r.course_id, title: r.course_title }],
        deleted: false,
        authorEstimate: r.estimated_minutes ? clampNorm(r.estimated_minutes * 60) : null,
        autoSeconds: auto,
      })
    }
  }

  const quizIds = idsOf('quiz')
  if (quizIds.length) {
    // Случайная выборка: вопросов — сколько велят правила; какие из них развёрнутые, заранее
    // не известно, поэтому «розгорнутих» у неё 0 (Р-22.7)
    const rows = await tx.execute(sql`
      select q.id, q.title, q.deleted_at is not null as deleted,
             case when q.selection_mode = 'random'
               then (select coalesce(sum((rr->>'count')::int), 0)::int
                       from jsonb_array_elements(case jsonb_typeof(q.random_rules) when 'array' then q.random_rules else '[]'::jsonb end) rr)
               else (select count(*)::int from quiz_questions qq where qq.quiz_id = q.id) end as questions,
             case when q.selection_mode = 'random' then 0
               else (select count(*)::int from quiz_questions qq join questions x on x.id = qq.question_id
                      where qq.quiz_id = q.id and x.kind in (${MANUAL})) end as open_questions
        from quizzes q where q.id = any(${uuidArray(quizIds)})`) as unknown as { id: string, title: string, deleted: boolean, questions: number, open_questions: number }[]
    const tracks = await courseTracks(tx, 'quiz', quizIds)
    for (const r of rows) {
      out.set(keyOf({ subjectType: 'quiz', subjectId: r.id }), {
        title: r.title, tracks: tracks.get(r.id) ?? [], deleted: r.deleted, authorEstimate: null,
        autoSeconds: autoQuizSeconds(Number(r.questions), Number(r.open_questions)),
      })
    }
  }

  const workshopIds = idsOf('workshop')
  if (workshopIds.length) {
    const rows = await tx.execute(sql`
      select w.id, w.title, w.deleted_at is not null as deleted from workshops w where w.id = any(${uuidArray(workshopIds)})`) as unknown as { id: string, title: string, deleted: boolean }[]
    const tracks = await courseTracks(tx, 'workshop', workshopIds)
    // Практикум — только норма автора: объём работы вне экрана система не оценит (§7.13)
    for (const r of rows) out.set(keyOf({ subjectType: 'workshop', subjectId: r.id }), { title: r.title, tracks: tracks.get(r.id) ?? [], deleted: r.deleted, authorEstimate: null, autoSeconds: null })
  }

  const nodeIds = idsOf('track_node')
  if (nodeIds.length) {
    const rows = await tx.execute(sql`
      select tn.id, coalesce(tn.title, tr.title) as title, tr.id as trajectory_id, tr.title as trajectory_title
        from trajectory_nodes tn join trajectories tr on tr.id = tn.trajectory_id
       where tn.id = any(${uuidArray(nodeIds)})`) as unknown as { id: string, title: string, trajectory_id: string, trajectory_title: string }[]
    for (const r of rows) out.set(keyOf({ subjectType: 'track_node', subjectId: r.id }), { title: r.title, tracks: [{ id: r.trajectory_id, title: r.trajectory_title }], deleted: false, authorEstimate: null, autoSeconds: null })
  }
  return out
}

/** Норма элемента, у которого строки ещё нет: число автора материала приоритетнее авторасчёта (§7.13). */
function defaultNorm(m: ElementMeta): NormValues {
  return m.authorEstimate !== null
    ? { source: 'author', authorSeconds: m.authorEstimate, autoSeconds: m.autoSeconds }
    : { source: 'auto', authorSeconds: null, autoSeconds: m.autoSeconds }
}

// ── Факт: агрегаты по элементу на едином каркасе отчётов ─────────────────────────────────

interface StatsFilter {
  scope: string[] | null
  includeArchived?: boolean
  locationId?: string
  from?: string
  to?: string
  subjectType?: LearningTimeSubjectType
  subjectIds?: string[]
}

interface ElementStats extends Subject {
  /** Завершённые прохождения с измеренным временем — все, включая недостоверные. */
  total: number
  unreliable: number
  /** Достоверные (`confidence <> 'unreliable'`) — «вибірка» (§7.15: недостоверные в норму не входят). */
  sample: number
  median: number | null
  p25: number | null
  p75: number | null
}

/**
 * «Завершённое прохождение» элемента (§7.13) — по его собственной отметке завершения: урок
 * зачтён в записи на курс; попытка теста отправлена (просроченная и аннулированная — нет);
 * сдача практикума отправлена хотя бы раз; шаг траектории пройден. Период — по дате этой
 * отметки. Строка витрины — «человек × элемент × запись на курс», время всех попыток и
 * устройств в ней уже сложено свёрткой.
 */
function completedSql(p: { from?: string, to?: string }): SQL {
  return sql`case t.subject_type
    when 'lesson' then exists (select 1 from lesson_progress lp
                                where lp.enrollment_id = t.enrollment_id and lp.lesson_id = t.subject_id and lp.status = 'completed'
                                  ${periodSql(sql`lp.completed_at`, p)})
    when 'quiz' then exists (select 1 from attempts a
                              where a.user_id = t.user_id and a.quiz_id = t.subject_id and a.enrollment_id is not distinct from t.enrollment_id
                                and a.status in ('submitted', 'review', 'passed', 'failed') ${periodSql(sql`a.submitted_at`, p)})
    when 'workshop' then exists (select 1 from workshop_submissions s
                                  where s.user_id = t.user_id and s.workshop_id = t.subject_id and s.enrollment_id is not distinct from t.enrollment_id
                                    and s.submitted_at is not null and s.status in ('submitted', 'in_review', 'rework', 'accepted', 'rejected')
                                    ${periodSql(sql`s.submitted_at`, p)})
    when 'track_node' then exists (select 1 from trajectory_node_states ns join trajectory_enrollments te on te.id = ns.enrollment_id
                                    where ns.node_id = t.subject_id and te.user_id = t.user_id and ns.status = 'done'
                                      ${periodSql(sql`ns.finished_at`, p)})
    else false end`
}

/**
 * Медиана, p25, p75 и выборка факта по элементам. Люди отобраны единым каркасом отчётов
 * (`frameJoins()`/`frameWhere()`): только сотрудники, в области видимости, без архивированных
 * по умолчанию. Из запроса наружу выходят только агрегаты по элементу — ни одного человека.
 */
async function observedStats(tx: TenantTx, f: StatsFilter): Promise<ElementStats[]> {
  const rows = await tx.execute(sql`
    with passes as (
      select t.subject_type, t.subject_id, t.content_seconds + t.attempt_seconds as secs, t.confidence
        from learning_time_totals t
        join users u on u.id = t.user_id
        ${frameJoins()}
       where true ${frameWhere({ scope: f.scope, includeArchived: f.includeArchived })}
         ${f.locationId ? sql`and pl.location_id = ${f.locationId}::uuid` : sql``}
         ${f.subjectType ? sql`and t.subject_type = ${f.subjectType}` : sql``}
         ${f.subjectIds ? sql`and t.subject_id = any(${uuidArray(f.subjectIds)})` : sql``}
         and ${completedSql(f)}
    )
    select subject_type, subject_id,
           count(*)::int as total,
           (count(*) filter (where confidence = 'unreliable'))::int as unreliable,
           (count(*) filter (where confidence <> 'unreliable'))::int as sample,
           round(percentile_cont(0.5) within group (order by secs) filter (where confidence <> 'unreliable'))::int as median,
           round(percentile_cont(0.25) within group (order by secs) filter (where confidence <> 'unreliable'))::int as p25,
           round(percentile_cont(0.75) within group (order by secs) filter (where confidence <> 'unreliable'))::int as p75
      from passes
     group by subject_type, subject_id`) as unknown as {
    subject_type: LearningTimeSubjectType, subject_id: string, total: number, unreliable: number, sample: number,
    median: number | null, p25: number | null, p75: number | null
  }[]
  return rows.map(r => ({
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    total: Number(r.total),
    unreliable: Number(r.unreliable),
    sample: Number(r.sample),
    median: r.median === null ? null : Number(r.median),
    p25: r.p25 === null ? null : Number(r.p25),
    p75: r.p75 === null ? null : Number(r.p75),
  }))
}

/** Факт, который можно показать и положить в норму: медиана и процентили — с 10 прохождений (Р-22.4). */
function shownStats(s: ElementStats | undefined) {
  const sample = s?.sample ?? 0
  return observedShown(sample) && s?.median !== null && s?.median !== undefined
    ? { sample, median: s.median, p25: s.p25 ?? s.median, p75: s.p75 ?? s.median }
    : { sample, median: null, p25: null, p75: null }
}

// ── Строки норм ────────────────────────────────────────────────────────────────────────────

type NormRow = typeof contentTimeNorms.$inferSelect

async function normRows(tx: TenantTx, subjects: Subject[], opts: { lock?: boolean } = {}): Promise<Map<string, NormRow>> {
  if (!subjects.length) return new Map()
  const rows = await tx.execute(sql`
    select n.* from content_time_norms n
      join unnest(${pgTextArray(subjects.map(s => s.subjectType))}, ${uuidArray(subjects.map(s => s.subjectId))}) as k(subject_type, subject_id)
        on k.subject_type = n.subject_type and k.subject_id = n.subject_id
    ${opts.lock ? sql`for update of n` : sql``}`) as unknown as Record<string, unknown>[]
  const out = new Map<string, NormRow>()
  for (const r of rows) {
    const row = rowFromSql(r)
    out.set(keyOf({ subjectType: row.subjectType as LearningTimeSubjectType, subjectId: row.subjectId }), row)
  }
  return out
}

function pgTextArray(values: readonly string[]): SQL {
  return values.length ? sql`array[${sql.join(values.map(v => sql`${v}::text`), sql`, `)}]::text[]` : sql`'{}'::text[]`
}

function rowFromSql(r: Record<string, unknown>): NormRow {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  const at = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string))
  return {
    id: r.id as string,
    createdAt: at(r.created_at)!,
    updatedAt: at(r.updated_at)!,
    tenantId: r.tenant_id as string,
    subjectType: r.subject_type as string,
    subjectId: r.subject_id as string,
    source: r.source as string,
    authorSeconds: num(r.author_seconds),
    autoSeconds: num(r.auto_seconds),
    observedSeconds: num(r.observed_seconds),
    observedP25: num(r.observed_p25),
    observedP75: num(r.observed_p75),
    observedSample: Number(r.observed_sample ?? 0),
    deviationFlag: r.deviation_flag as string,
    recalculatedAt: at(r.recalculated_at),
    updatedBy: (r.updated_by as string | null) ?? null,
  }
}

const valuesOf = (n: NormRow): NormValues => ({ source: n.source as ContentTimeNormSource, authorSeconds: n.authorSeconds, autoSeconds: n.autoSeconds })

function toDto(s: Subject, meta: ElementMeta, row: NormRow | undefined): TimeNorm {
  // Авторасчёт — по текущему объёму: правка текста или состава теста видна сразу, до пересчёта
  const values: NormValues = row ? { ...valuesOf(row), autoSeconds: meta.autoSeconds } : defaultNorm(meta)
  const observed = row && observedShown(row.observedSample) ? row : null
  return {
    subjectType: s.subjectType,
    subjectId: s.subjectId,
    title: meta.title,
    persisted: !!row,
    source: values.source,
    plannedSeconds: plannedSeconds(values),
    authorSeconds: values.authorSeconds,
    autoSeconds: values.autoSeconds,
    observedSeconds: observed?.observedSeconds ?? null,
    observedP25: observed?.observedP25 ?? null,
    observedP75: observed?.observedP75 ?? null,
    observedSample: row?.observedSample ?? 0,
    deviationFlag: (row?.deviationFlag as ContentTimeDeviationFlag | undefined) ?? 'no_data',
    canApplyObserved: !!row && canApplyObserved({ observedSeconds: row.observedSeconds, observedSample: row.observedSample }),
    recalculatedAt: row?.recalculatedAt?.toISOString() ?? null,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  }
}

/** Элемент есть в тенанте и не удалён; чужой тенант RLS не показывает — `not_found` (CLAUDE.md п. 15). */
async function liveMeta(tx: TenantTx, s: Subject): Promise<ElementMeta | null> {
  const meta = (await elementsMeta(tx, [s])).get(keyOf(s))
  return meta && !meta.deleted ? meta : null
}

export type NormError = 'not_found' | 'value_range' | 'sample_too_small'

/** GET `/content/time-norms/:subjectType/:subjectId` — норма и её источник (§10). */
export async function getTimeNorm(ctx: Ctx, s: Subject): Promise<{ ok: true, norm: TimeNorm } | { ok: false, code: 'not_found' }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const meta = await liveMeta(tx, s)
    if (!meta) return { ok: false as const, code: 'not_found' as const }
    const row = (await normRows(tx, [s])).get(keyOf(s))
    return { ok: true as const, norm: toDto(s, meta, row) }
  })
}

/**
 * Записать норму и пересчитать флаг по уже посчитанному факту: исправленный план сразу
 * снимает (или ставит) флаг, не дожидаясь воскресного пересчёта. Уведомление шлёт только
 * пересчёт (Р-22.6): автор, поправивший норму, видит флаг на экране сам.
 */
async function writeNorm(tx: TenantTx, ctx: Ctx, s: Subject, meta: ElementMeta, next: NormValues, action: string): Promise<NormRow> {
  const prev = (await normRows(tx, [s], { lock: true })).get(keyOf(s))
  const values: NormValues = { ...next, autoSeconds: meta.autoSeconds }
  const flag = deviationFlag({
    plannedSeconds: plannedSeconds(values),
    observedSeconds: prev && observedShown(prev.observedSample) ? prev.observedSeconds : null,
    sample: prev?.observedSample ?? 0,
  })
  const now = new Date()
  const [row] = await tx.insert(contentTimeNorms).values({
    tenantId: ctx.tenantId,
    subjectType: s.subjectType,
    subjectId: s.subjectId,
    source: values.source,
    authorSeconds: values.authorSeconds,
    autoSeconds: values.autoSeconds,
    deviationFlag: flag,
    updatedBy: ctx.actorId,
  }).onConflictDoUpdate({
    target: [contentTimeNorms.tenantId, contentTimeNorms.subjectType, contentTimeNorms.subjectId],
    set: { source: values.source, authorSeconds: values.authorSeconds, autoSeconds: values.autoSeconds, deviationFlag: flag, updatedBy: ctx.actorId, updatedAt: now },
  }).returning()
  await recordAudit(tx, {
    tenantId: ctx.tenantId, actorId: ctx.actorId, action, entity: 'content_time_norm', entityId: row!.id,
    before: prev ? { source: prev.source, plannedSeconds: plannedSeconds(valuesOf(prev)), deviationFlag: prev.deviationFlag } : null,
    after: { subjectType: s.subjectType, subjectId: s.subjectId, source: row!.source, plannedSeconds: plannedSeconds(values), deviationFlag: flag },
  })
  return row!
}

/** PUT `/content/time-norms/:subjectType/:subjectId` — форма «Норма часу елемента» (§6.3). */
export async function putTimeNorm(ctx: Ctx, s: Subject, input: TimeNormPut): Promise<{ ok: true, norm: TimeNorm } | { ok: false, code: NormError }> {
  if (input.source === 'observed') return applyObservedNorm(ctx, s)
  if (input.source === 'author' && !authorSecondsValid(input.authorSeconds)) return { ok: false, code: 'value_range' }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const meta = await liveMeta(tx, s)
    if (!meta) return { ok: false as const, code: 'not_found' as const }
    const next: NormValues = input.source === 'author'
      ? { source: 'author', authorSeconds: input.authorSeconds, autoSeconds: meta.autoSeconds }
      : { source: 'auto', authorSeconds: null, autoSeconds: meta.autoSeconds }
    const row = await writeNorm(tx, ctx, s, meta, next, 'time_norm.update')
    return { ok: true as const, norm: toDto(s, meta, row) }
  })
}

/**
 * «Застосувати» (§6.3, §7.13): медиана факта становится нормой **только нажатием автора** —
 * и замораживается в этот момент (Р-22.2). Дальше пересчёт обновляет медиану, но не норму:
 * «молча система норму не меняет никогда».
 */
export async function applyObservedNorm(ctx: Ctx, s: Subject): Promise<{ ok: true, norm: TimeNorm } | { ok: false, code: NormError }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const meta = await liveMeta(tx, s)
    if (!meta) return { ok: false as const, code: 'not_found' as const }
    const current = (await normRows(tx, [s], { lock: true })).get(keyOf(s))
    if (!current || !canApplyObserved({ observedSeconds: current.observedSeconds, observedSample: current.observedSample })) {
      return { ok: false as const, code: 'sample_too_small' as const }
    }
    const next: NormValues = { source: 'observed', authorSeconds: appliedObservedSeconds(current.observedSeconds!), autoSeconds: meta.autoSeconds }
    const row = await writeNorm(tx, ctx, s, meta, next, 'time_norm.apply_observed')
    return { ok: true as const, norm: toDto(s, meta, row) }
  })
}

/**
 * «Розрахунковий час» элемента для снимка в очередь проверки (`review_queue_items.estimated_seconds`,
 * §7.14: «попадает в очередь снимком на момент сдачи — правка нормы историю не переписывает»).
 * Только чтение: строки нормы здесь не создаются, для элемента без строки берётся норма по
 * умолчанию — число автора материала или авторасчёт.
 */
export async function plannedSecondsFor(tx: TenantTx, s: Subject): Promise<number | null> {
  const meta = (await elementsMeta(tx, [s])).get(keyOf(s))
  if (!meta) return null
  const row = (await normRows(tx, [s])).get(keyOf(s))
  return plannedSeconds(row ? { ...valuesOf(row), autoSeconds: meta.autoSeconds } : defaultNorm(meta))
}

/**
 * «Орієнтовний час» материала (`resources.estimated_minutes`) — поле автора: при сохранении
 * материала оно становится нормой каждого урока с этим материалом (`37` §3.5, «синхронизируется
 * в `author_seconds` при сохранении материала»). Последнее явное действие автора выигрывает:
 * новое число заменяет и принятую раньше медиану. Очищенное поле возвращает к авторасчёту
 * только нормы, взятые из него же (`source = 'author'`); принятая медиана остаётся.
 */
export async function syncMaterialEstimate(tx: TenantTx, ctx: Ctx, resourceId: string, estimatedMinutes: number | null): Promise<number> {
  const lessons = await tx.execute(sql`
    select l.id from lessons l where l.item_type = 'resource' and l.item_id = ${resourceId}::uuid`) as unknown as { id: string }[]
  if (!lessons.length) return 0
  const subjects: Subject[] = lessons.map(l => ({ subjectType: 'lesson', subjectId: l.id }))
  const rows = await normRows(tx, subjects, { lock: true })
  if (!rows.size) return 0
  const meta = await elementsMeta(tx, subjects)
  let n = 0
  for (const [key, row] of rows) {
    const m = meta.get(key)
    if (!m) continue
    let next: NormValues | null = null
    if (estimatedMinutes !== null) next = { source: 'author', authorSeconds: clampNorm(estimatedMinutes * 60), autoSeconds: m.autoSeconds }
    else if (row.source === 'author') next = { source: 'auto', authorSeconds: null, autoSeconds: m.autoSeconds }
    if (!next || (next.source === row.source && next.authorSeconds === row.authorSeconds)) continue
    await writeNorm(tx, ctx, { subjectType: 'lesson', subjectId: row.subjectId }, m, next, 'time_norm.sync_material')
    n++
  }
  return n
}

// ── `time.norms_recalc`: факт, флаг, уведомление автору (§11) ────────────────────────────

export interface RecalcStats { elements: number, written: number, notified: number }

const CHUNK = 200

/** Адресаты `content_time_deviation` (§8): действующие авторы элемента, иначе — владелец категории. */
async function deviationRecipients(tx: TenantTx, s: Subject, tracks: TimePlanFactTrack[]): Promise<string[]> {
  const authorIds = s.subjectType === 'track_node'
    ? sql`(select array_remove(array[tr.created_by], null) from trajectory_nodes tn join trajectories tr on tr.id = tn.trajectory_id where tn.id = ${s.subjectId}::uuid)`
    : sql`(select ${authorIdsSql('i')} from (select ${s.subjectType}::text as target_type, ${s.subjectId}::uuid as target_id) i)`
  // Уволенный через офбординг и заблокированный — не адресаты: то же условие, что у оси
  // `users_active` и маршрутизации жалоб (`ACTIVE_EMPLOYEES_ONLY`, docs/v2/36 §7.5 б)
  const authors = await tx.execute(sql`
    select u.id from unnest(coalesce(${authorIds}, '{}'::uuid[])) with ordinality x(id, ord)
      join users u on u.id = x.id
     where true ${ACTIVE_EMPLOYEES_ONLY('u')}
     order by x.ord`) as unknown as { id: string }[]
  if (authors.length) return [...new Set(authors.map(a => a.id))]
  // Все авторы ушли — сигнал владельцу категории курса, как жалоба (`36` §7.5 в, Р-22.8)
  const courseIds = s.subjectType === 'track_node' ? [] : tracks.map(t => t.id)
  if (!courseIds.length) return []
  const owners = await tx.execute(sql`
    select distinct u.id from courses c
      join course_categories cc on cc.id = c.category_id
      join users u on u.id = cc.owner_id
     where c.id = any(${uuidArray(courseIds)}) ${ACTIVE_EMPLOYEES_ONLY('u')}`) as unknown as { id: string }[]
  return owners.map(o => o.id)
}

/** Отчёт, открытый на этом элементе, — кнопка «Відкрити» колокольчика (`refUrl`). */
export const planFactUrl = (s: Subject) => `/admin/reports/time-plan-fact?subjectType=${s.subjectType}&subjectId=${s.subjectId}`

async function notifyDeviation(tx: TenantTx, tenantId: string, normId: string, s: Subject, meta: ElementMeta, info: { flag: ContentTimeDeviationFlag, median: number, planned: number }, day: string): Promise<number> {
  const recipients = await deviationRecipients(tx, s, meta.tracks)
  if (!recipients.length) return 0
  const locales = await tx.execute(sql`
    select u.id, u.locale, (select t.locale from tenants t where t.id = ${tenantId}::uuid) as tenant_locale
      from unnest(${uuidArray(recipients)}) x(id)
      join users u on u.id = x.id`) as unknown as { id: string, locale: string | null, tenant_locale: string | null }[]
  let n = 0
  for (const userId of recipients) {
    const l = locales.find(x => x.id === userId)
    // Язык адресата: users.locale ?? tenants.locale ?? 'uk' (docs/23 §3.4)
    const locale = recipientLocale(l?.locale, l?.tenant_locale)
    if (await enqueueNotification(tx, {
      tenantId, userId, code: 'content_time_deviation', channel: 'inapp',
      payload: {
        title: meta.title,
        fact: formatNumber(wholeMinutes(info.median), locale),
        plan: formatNumber(wholeMinutes(info.planned), locale),
        url: planFactUrl(s),
      },
      dedupKey: `content_time_deviation:${normId}:${info.flag}:${day}:${userId}`,
      refType: 'content_time_norm', refId: normId,
    })) n++
  }
  return n
}

async function recalcChunk(tx: TenantTx, tenantId: string, subjects: Subject[], stats: Map<string, ElementStats>, now: Date): Promise<{ written: number, notified: number }> {
  const meta = await elementsMeta(tx, subjects)
  // Строки, которые уже есть, — под блокировкой: правка нормы автором не проскочит между
  // чтением его числа и записью флага, посчитанного по этому числу
  const existing = await normRows(tx, subjects, { lock: true })
  const values: SQL[] = []
  const planned = new Map<string, { flag: ContentTimeDeviationFlag, sample: number, median: number | null, planned: number | null, prev: { flag: ContentTimeDeviationFlag, sample: number } | null }>()
  for (const s of subjects) {
    const key = keyOf(s)
    const m = meta.get(key)
    if (!m) continue // элемент удалён: норма остаётся как была, пересчитывать нечего
    const row = existing.get(key)
    const norm: NormValues = row ? { ...valuesOf(row), autoSeconds: m.autoSeconds } : defaultNorm(m)
    const st = shownStats(stats.get(key))
    const plan = plannedSeconds(norm)
    const flag = deviationFlag({ plannedSeconds: plan, observedSeconds: st.median, sample: st.sample })
    planned.set(key, { flag, sample: st.sample, median: st.median, planned: plan, prev: row ? { flag: row.deviationFlag as ContentTimeDeviationFlag, sample: row.observedSample } : null })
    values.push(sql`(${tenantId}::uuid, ${s.subjectType}::text, ${s.subjectId}::uuid, ${norm.source}::text, ${norm.authorSeconds}::int, ${norm.autoSeconds}::int,
      ${st.median}::int, ${st.p25}::int, ${st.p75}::int, ${st.sample}::int, ${flag}::text, ${now.toISOString()}::timestamptz)`)
  }
  if (!values.length) return { written: 0, notified: 0 }
  // Источник и число автора пересчёт не меняет никогда. Флаг пишется, только если строка всё
  // ещё с той нормой, по которой он посчитан: новая строка, созданная правкой автора в ту же
  // секунду, сохраняет свой флаг, а следующий пересчёт выровняет её сам.
  const rows = await tx.execute(sql`
    insert into content_time_norms (tenant_id, subject_type, subject_id, source, author_seconds, auto_seconds,
      observed_seconds, observed_p25, observed_p75, observed_sample, deviation_flag, recalculated_at)
    values ${sql.join(values, sql`, `)}
    on conflict on constraint uq_content_time_norms_subject do update set
      auto_seconds = excluded.auto_seconds,
      observed_seconds = excluded.observed_seconds, observed_p25 = excluded.observed_p25, observed_p75 = excluded.observed_p75,
      observed_sample = excluded.observed_sample,
      deviation_flag = case when (content_time_norms.source, content_time_norms.author_seconds) is not distinct from (excluded.source, excluded.author_seconds)
                            then excluded.deviation_flag else content_time_norms.deviation_flag end,
      recalculated_at = excluded.recalculated_at,
      updated_at = case when (content_time_norms.auto_seconds, content_time_norms.observed_seconds, content_time_norms.observed_p25,
                              content_time_norms.observed_p75, content_time_norms.observed_sample, content_time_norms.deviation_flag)
                             is distinct from (excluded.auto_seconds, excluded.observed_seconds, excluded.observed_p25,
                              excluded.observed_p75, excluded.observed_sample, excluded.deviation_flag)
                        then now() else content_time_norms.updated_at end
    returning id, subject_type, subject_id`) as unknown as { id: string, subject_type: LearningTimeSubjectType, subject_id: string }[]

  let notified = 0
  const day = now.toISOString().slice(0, 10)
  for (const r of rows) {
    const s: Subject = { subjectType: r.subject_type, subjectId: r.subject_id }
    const p = planned.get(keyOf(s))
    if (!p || p.median === null || p.planned === null) continue
    if (!deviationNoticeDue(p.prev, { flag: p.flag, sample: p.sample })) continue
    notified += await notifyDeviation(tx, tenantId, r.id, s, meta.get(keyOf(s))!, { flag: p.flag, median: p.median, planned: p.planned }, day)
  }
  return { written: rows.length, notified }
}

/**
 * `time.norms_recalc` (§11, еженедельно): медиана, p25, p75 и выборка факта по всему тенанту,
 * флаг отклонения, уведомление автору при входе элемента в отклонение на выборке ≥ 20.
 * Строка нормы появляется у каждого элемента, где есть хоть одно завершённое измеренное
 * прохождение, — с нормой по умолчанию; у элементов, чья норма уже есть, пересчитывается
 * факт. Идемпотентен: повторный прогон ничего не меняет и не уведомляет повторно.
 */
export async function recalcNorms(tenantId: string, opts: { now?: Date } = {}): Promise<RecalcStats> {
  const now = opts.now ?? new Date()
  const { stats, keys } = await withTenant(tenantId, null, async (tx) => {
    const list = await observedStats(tx, { scope: null })
    const known = await tx.execute(sql`select subject_type, subject_id from content_time_norms`) as unknown as { subject_type: LearningTimeSubjectType, subject_id: string }[]
    const all = new Map<string, Subject>()
    for (const s of list) all.set(keyOf(s), { subjectType: s.subjectType, subjectId: s.subjectId })
    for (const k of known) all.set(keyOf({ subjectType: k.subject_type, subjectId: k.subject_id }), { subjectType: k.subject_type, subjectId: k.subject_id })
    return { stats: new Map(list.map(s => [keyOf(s), s])), keys: [...all.values()] }
  })
  const out: RecalcStats = { elements: keys.length, written: 0, notified: 0 }
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK)
    const r = await withTenant(tenantId, null, tx => recalcChunk(tx, tenantId, chunk, stats, now))
    out.written += r.written
    out.notified += r.notified
  }
  return out
}

// ── Отчёт «План і факт часу» (§9.3) ────────────────────────────────────────────────────────

/**
 * Обезличенный отчёт по контенту (§9.3, §7.14 в): строка — элемент, в ней только агрегаты.
 * Детализации «кто составил цифру» нет и не будет (docs/22 §3 п. 4 здесь не применяется):
 * поимённое время — только `GET /learning/time/totals` по скоупу `time.metrics.view`.
 * Считается сразу при запросе, тем же расчётом, что и норма (`observedStats()`), по области
 * видимости смотрящего.
 */
export async function timePlanFactReport(v: Viewer, q: TimePlanFactQuery): Promise<TimePlanFactReport> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const stats = await observedStats(tx, {
      scope: v.scope, includeArchived: q.includeArchived, locationId: q.locationId, from: q.from, to: q.to,
      subjectType: q.subjectType, subjectIds: q.subjectId ? [q.subjectId] : undefined,
    })
    const subjects: Subject[] = stats.map(s => ({ subjectType: s.subjectType, subjectId: s.subjectId }))
    const meta = await elementsMeta(tx, subjects)
    const norms = await normRows(tx, subjects)

    const rows: TimePlanFactRow[] = []
    for (const s of stats) {
      const key = keyOf(s)
      const m = meta.get(key)
      if (!m || m.deleted) continue
      if (q.trackId && !m.tracks.some(t => t.id === q.trackId)) continue
      const row = norms.get(key)
      const norm: NormValues = row ? { ...valuesOf(row), autoSeconds: m.autoSeconds } : defaultNorm(m)
      const st = shownStats(s)
      const plan = plannedSeconds(norm)
      const deviation = deviationFlag({ plannedSeconds: plan, observedSeconds: st.median, sample: st.sample })
      if (q.deviation && deviation !== q.deviation) continue
      if (q.minSample !== undefined && st.sample < q.minSample) continue
      rows.push({
        key,
        subjectType: s.subjectType,
        subjectId: s.subjectId,
        title: m.title,
        tracks: m.tracks,
        plannedSeconds: plan,
        source: norm.source,
        medianSeconds: st.median,
        p25Seconds: st.p25,
        p75Seconds: st.p75,
        sample: st.sample,
        factor: deviation === 'no_data' ? null : deviationFactor(plan, st.median),
        deviation,
        unreliableShare: observedShown(s.total) ? s.unreliable / s.total : null,
      })
    }
    rows.sort(comparePlanFact)
    return {
      rows,
      summary: {
        elements: rows.length,
        tooSlow: rows.filter(r => r.deviation === 'too_slow').length,
        tooFast: rows.filter(r => r.deviation === 'too_fast').length,
        noData: rows.filter(r => r.deviation === 'no_data').length,
      },
      computedAt: new Date().toISOString(),
    }
  })
}

/** Строки выгрузки xlsx — ровно те, что на экране (docs/22 §3), минуты с одним знаком. */
export function planFactExportRows(r: TimePlanFactReport): Record<string, unknown>[] {
  const min = (s: number | null) => (s === null ? null : Math.round(s / 6) / 10)
  return r.rows.map(x => ({
    element: x.title,
    type: x.subjectType,
    track: x.tracks.map(t => t.title).join(', '),
    planned_min: min(x.plannedSeconds),
    source: x.source,
    median_min: min(x.medianSeconds),
    p25_min: min(x.p25Seconds),
    p75_min: min(x.p75Seconds),
    sample: x.sample,
    deviation: x.deviation,
    factor: x.factor === null ? null : Math.round(x.factor * 100) / 100,
    unreliable_share: x.unreliableShare === null ? null : Math.round(x.unreliableShare * 1000) / 1000,
  }))
}
