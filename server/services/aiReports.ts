import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { withTenant, type TenantTx } from '../utils/withTenant'
import { EMPLOYEES_ONLY } from './repo/people'
import { QUALITY_MIN_DECISIONS } from './aiQuality'
import type { AiReportQuery } from '../../shared/schemas/ai'

/**
 * Отчёты ИИ (`docs/v2/30-ai-interview.md` §9.3–§9.5): «Якість моделі», «Допомога перевіряючому»,
 * «Вартість ШІ». Читает HR/админ со скоупом `ai.audit` (`30` §2 «Журнал ИИ-вызовов: содержимое
 * | только метрики»), поэтому в конструктор выгрузок (`reportBuilder.ts`, скоуп `report.builder`)
 * отчёты не регистрируются — там их увидел бы любой, кому дали конструктор (`44` Р-AI.3).
 *
 * **О людях отчёты ничего не решают и кандидатов не называют** (инварианты 17, 18): качество
 * модели — в разрезе версии промпта и критерия, без кандидатов; помощь проверяющему — по
 * наставникам-сотрудникам (`kind = 'employee'`), вывод отчёта — о подсказке, а не о человеке;
 * стоимость — по роли вызова и дням. Выхода модели, цитат и обоснований в отчётах нет.
 *
 * Период: `from`/`to` включительно, по дате в поясе тенанта.
 */

interface Ctx { tenantId: string, actorId: string }

const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round(part / whole * 1000) / 10 : null)
const round = (v: number | string | null, digits: number): number | null => (v === null ? null : Math.round(Number(v) * 10 ** digits) / 10 ** digits)

/** Условие периода по колонке времени в поясе тенанта. */
function period(col: SQL, tz: string, q: Pick<AiReportQuery, 'from' | 'to'>): SQL {
  return sql`${q.from ? sql`and (${col} at time zone ${tz})::date >= ${q.from}::date` : sql``}
             ${q.to ? sql`and (${col} at time zone ${tz})::date <= ${q.to}::date` : sql``}`
}

async function tenantTz(tx: TenantTx, tenantId: string): Promise<string> {
  const [r] = await tx.execute(sql`select timezone from tenants where id = ${tenantId}::uuid`) as unknown as { timezone: string }[]
  return r?.timezone ?? 'Europe/Kyiv'
}

// ── §9.3 Качество модели ────────────────────────────────────────────────────────────────

export interface QualityRow {
  promptVersion: string
  scores: number
  decided: number
  matchPct: number | null
  minorPct: number | null
  majorPct: number | null
  avgConfidence: number | null
  sessions: number
  needsHumanPct: number | null
  /** Решений меньше `QUALITY_MIN_DECISIONS` — доли шумят, выводов не делать (Р-29.11). */
  smallSample: boolean
}

export interface QualityCriterionRow {
  promptVersion: string
  criterion: string
  scenario: string
  scores: number
  decided: number
  matchPct: number | null
  minorPct: number | null
  majorPct: number | null
  avgConfidence: number | null
  smallSample: boolean
}

/**
 * «Якість моделі» (`30` §9.3): по версии промпта — оценок, доля `match`/`minor`/`major` среди
 * перепроверенных человеком, средняя уверенность, доля сессий `needs_human`; разрез по
 * критериям — какой критерий модель понимает хуже. Версии между собой не сравниваются (`30`
 * §7.16): каждая — своя строка со своей статистикой. Доли — от решений человека, а не от всех
 * оценок: непроверенная оценка ни согласием, ни расхождением не является.
 */
export async function aiQualityReport(ctx: Ctx, q: AiReportQuery): Promise<{ rows: QualityRow[], criteria: QualityCriterionRow[] }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const tz = await tenantTz(tx, ctx.tenantId)
    type Agg = { prompt_version: string, scores: number, decided: number, match: number, minor: number, major: number, avg_conf: string | null }
    const agg = sql`count(*)::int as scores,
             count(*) filter (where s.agreement <> 'pending')::int as decided,
             count(*) filter (where s.agreement = 'match')::int as match,
             count(*) filter (where s.agreement = 'minor')::int as minor,
             count(*) filter (where s.agreement = 'major')::int as major,
             avg(s.confidence) as avg_conf`
    const byVersion = await tx.execute(sql`
      select coalesce(c.prompt_version, '') as prompt_version, ${agg}
        from interview_criterion_scores s left join ai_calls c on c.id = s.ai_call_id
       where true ${period(sql`s.created_at`, tz, q)}
       group by 1 order by 1 desc`) as unknown as Agg[]
    const byCriterion = await tx.execute(sql`
      select coalesce(c.prompt_version, '') as prompt_version, cr.name_uk as criterion, sc.name as scenario, ${agg}
        from interview_criterion_scores s
        left join ai_calls c on c.id = s.ai_call_id
        join interview_criteria cr on cr.id = s.criterion_id
        join interview_scenarios sc on sc.id = cr.scenario_id
       where true ${period(sql`s.created_at`, tz, q)}
       group by 1, cr.id, cr.name_uk, sc.name
       order by 1 desc, (count(*) filter (where s.agreement = 'major'))::float / greatest(count(*) filter (where s.agreement <> 'pending'), 1) desc, cr.name_uk`) as unknown as (Agg & { criterion: string, scenario: string })[]
    // Доля `needs_human` — от сессий, которые оценивала эта версия (последний вызов оценки сессии)
    const sessions = await tx.execute(sql`
      with last_call as (
        select distinct on (c.ref_id) c.ref_id as session_id, c.prompt_version
          from ai_calls c
         where c.purpose = 'interview_score' and c.ref_kind = 'interview_session' and c.ref_id is not null
           ${period(sql`c.created_at`, tz, q)}
         order by c.ref_id, c.id desc)
      select lc.prompt_version, count(*)::int as sessions, count(*) filter (where s.state = 'needs_human')::int as needs_human
        from last_call lc join interview_sessions s on s.id = lc.session_id
       group by 1`) as unknown as { prompt_version: string, sessions: number, needs_human: number }[]
    const bySession = new Map(sessions.map(s => [s.prompt_version, s]))
    const shares = (r: Agg) => ({
      scores: r.scores, decided: r.decided,
      matchPct: pct(r.match, r.decided), minorPct: pct(r.minor, r.decided), majorPct: pct(r.major, r.decided),
      avgConfidence: round(r.avg_conf, 3), smallSample: r.decided < QUALITY_MIN_DECISIONS,
    })
    const versions = new Set([...byVersion.map(r => r.prompt_version), ...sessions.map(s => s.prompt_version)])
    const rows: QualityRow[] = [...versions].sort().reverse().map((v) => {
      const r = byVersion.find(x => x.prompt_version === v) ?? { prompt_version: v, scores: 0, decided: 0, match: 0, minor: 0, major: 0, avg_conf: null }
      const s = bySession.get(v)
      return { promptVersion: v, ...shares(r), sessions: s?.sessions ?? 0, needsHumanPct: pct(s?.needs_human ?? 0, s?.sessions ?? 0) }
    })
    return {
      rows,
      criteria: byCriterion.map(r => ({ promptVersion: r.prompt_version, criterion: r.criterion, scenario: r.scenario, ...shares(r) })),
    }
  })
}

export function qualityExportRows(r: Awaited<ReturnType<typeof aiQualityReport>>): Record<string, unknown>[] {
  const line = (level: string, x: Omit<QualityCriterionRow, 'criterion' | 'scenario'> & { criterion?: string, scenario?: string, sessions?: number, needsHumanPct?: number | null }) => ({
    level, prompt_version: x.promptVersion || '—', scenario: x.scenario ?? '', criterion: x.criterion ?? '', scores: x.scores, decided: x.decided,
    match_pct: x.matchPct, minor_pct: x.minorPct, major_pct: x.majorPct, avg_confidence: x.avgConfidence,
    sessions: x.sessions ?? '', needs_human_pct: x.needsHumanPct ?? '', small_sample: x.smallSample,
  })
  return [...r.rows.map(x => line('version', x)), ...r.criteria.map(x => line('criterion', x))]
}

// ── §9.4 Помощь проверяющему ────────────────────────────────────────────────────────────

export interface ReviewHelpRow {
  reviewerId: string
  reviewer: string
  reviews: number
  hints: number
  shown: number
  match: number
  minor: number
  major: number
  notShown: number
  /** Доля `match` среди решений по показанной подсказке. */
  matchPct: number | null
  /** Средняя длительность проверки, мин: от взятия в работу до решения; с показанной подсказкой и без неё. */
  avgMinWithHint: number | null
  avgMinWithoutHint: number | null
  withHintMeasured: number
  withoutHintMeasured: number
}

/**
 * «Допомога перевіряючому» (`30` §9.4): наставник · проверок · подсказок показано · `agreement`
 * · среднее время проверки с подсказкой и без. Проверка — закрытая работа очереди
 * (`review_queue_items`, `status = 'done'`) развёрнутого ответа теста или практики — тех
 * типов, к которым бывает подсказка (`30` §7.13). Наставник — тот, кто принял решение
 * (`assigned_reviewer_id` закрытой работы, `reviewQueue.ts#closeReview`). Время — от
 * `claimed_at` до `completed_at`; работа, решённая без взятия в работу, во время не входит
 * (длительность не измерена), но в число проверок — входит.
 *
 * «С подсказкой» — панель раскрыта (`shown_at`); подсказка была, но не раскрыта, — «без»:
 * вопрос отчёта в том, ускоряет ли **чтение** подсказки. Имени проверяемого в отчёте нет.
 */
export async function aiReviewHelpReport(ctx: Ctx, q: AiReportQuery): Promise<{ rows: ReviewHelpRow[] }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const tz = await tenantTz(tx, ctx.tenantId)
    const rows = await tx.execute(sql`
      with done as (
        select r.assigned_reviewer_id as reviewer_id, r.claimed_at, r.completed_at, h.state as hint_state, h.shown_at, h.agreement,
               case when r.claimed_at is not null and r.claimed_at <= r.completed_at
                    then extract(epoch from (r.completed_at - r.claimed_at)) / 60 end as minutes
          from review_queue_items r
          left join ai_review_hints h
            on h.target_id = r.source_id
           and h.target_kind = case r.task_type when 'quiz_open_answer' then 'attempt_answer' else 'workshop_submission' end
         where r.status = 'done' and r.task_type in ('quiz_open_answer', 'workshop') and r.assigned_reviewer_id is not null
           ${period(sql`r.completed_at`, tz, q)})
      select u.id as reviewer_id, u.full_name as reviewer,
             count(*)::int as reviews,
             count(*) filter (where d.hint_state = 'ready')::int as hints,
             count(*) filter (where d.shown_at is not null)::int as shown,
             count(*) filter (where d.agreement = 'match')::int as match,
             count(*) filter (where d.agreement = 'minor')::int as minor,
             count(*) filter (where d.agreement = 'major')::int as major,
             count(*) filter (where d.agreement = 'not_shown')::int as not_shown,
             avg(d.minutes) filter (where d.shown_at is not null) as with_hint,
             avg(d.minutes) filter (where d.shown_at is null) as without_hint,
             count(d.minutes) filter (where d.shown_at is not null)::int as with_n,
             count(d.minutes) filter (where d.shown_at is null)::int as without_n
        from done d join users u on u.id = d.reviewer_id
       where true ${EMPLOYEES_ONLY('u')}
       group by u.id, u.full_name
       order by count(*) desc, u.full_name`) as unknown as {
      reviewer_id: string, reviewer: string, reviews: number, hints: number, shown: number, match: number, minor: number, major: number,
      not_shown: number, with_hint: string | null, without_hint: string | null, with_n: number, without_n: number
    }[]
    return {
      rows: rows.map(r => ({
        reviewerId: r.reviewer_id, reviewer: r.reviewer, reviews: r.reviews, hints: r.hints, shown: r.shown,
        match: r.match, minor: r.minor, major: r.major, notShown: r.not_shown, matchPct: pct(r.match, r.match + r.minor + r.major),
        avgMinWithHint: round(r.with_hint, 1), avgMinWithoutHint: round(r.without_hint, 1), withHintMeasured: r.with_n, withoutHintMeasured: r.without_n,
      })),
    }
  })
}

export function reviewHelpExportRows(r: Awaited<ReturnType<typeof aiReviewHelpReport>>): Record<string, unknown>[] {
  return r.rows.map(x => ({
    reviewer: x.reviewer, reviews: x.reviews, hints: x.hints, shown: x.shown, match: x.match, minor: x.minor, major: x.major,
    not_shown: x.notShown, match_pct: x.matchPct, avg_min_with_hint: x.avgMinWithHint, avg_min_without_hint: x.avgMinWithoutHint,
  }))
}

// ── §9.5 Стоимость ИИ ───────────────────────────────────────────────────────────────────

export interface CostRow {
  day: string
  purpose: string
  currency: string
  calls: number
  tokensIn: number
  tokensOut: number
  costMinor: number
  avgLatencyMs: number | null
  errorPct: number | null
}

/**
 * «Вартість ШІ» (`30` §9.5): по роли вызова и по дням — вызовов, токенов, `cost_minor`, средняя
 * задержка, доля ошибок. Ошибка — `failed` и `timeout` (провайдер не справился); `refused` и
 * `degraded` — не ошибка модели, а отказ по подписке или оси, и в долю не входят. Валюта —
 * своя строка: суммы разных валют не складываются. Итог — по роли за весь период.
 */
export async function aiCostReport(ctx: Ctx, q: AiReportQuery): Promise<{ rows: CostRow[], totals: Omit<CostRow, 'day'>[] }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const tz = await tenantTz(tx, ctx.tenantId)
    type Raw = { day?: string, purpose: string, currency: string, calls: number, tokens_in: number, tokens_out: number, cost: number, latency: string | null, errors: number }
    const agg = sql`c.purpose, c.currency, count(*)::int as calls,
             coalesce(sum(c.tokens_in), 0)::int as tokens_in, coalesce(sum(c.tokens_out), 0)::int as tokens_out,
             coalesce(sum(c.cost_minor), 0)::bigint::float8 as cost, avg(c.latency_ms) as latency,
             count(*) filter (where c.status in ('failed', 'timeout'))::int as errors`
    const where = sql`where true ${period(sql`c.created_at`, tz, q)} ${q.purpose ? sql`and c.purpose = ${q.purpose}` : sql``}`
    const daily = await tx.execute(sql`
      select to_char((c.created_at at time zone ${tz})::date, 'YYYY-MM-DD') as day, ${agg}
        from ai_calls c ${where}
       group by 1, c.purpose, c.currency order by 1 desc, c.purpose`) as unknown as Raw[]
    const total = await tx.execute(sql`
      select ${agg} from ai_calls c ${where}
       group by c.purpose, c.currency order by c.purpose`) as unknown as Raw[]
    const map = (r: Raw) => ({
      purpose: r.purpose, currency: r.currency, calls: r.calls, tokensIn: r.tokens_in, tokensOut: r.tokens_out, costMinor: Number(r.cost),
      avgLatencyMs: r.latency === null ? null : Math.round(Number(r.latency)), errorPct: pct(r.errors, r.calls),
    })
    return { rows: daily.map(r => ({ day: r.day!, ...map(r) })), totals: total.map(map) }
  })
}

export function costExportRows(r: Awaited<ReturnType<typeof aiCostReport>>): Record<string, unknown>[] {
  return r.rows.map(x => ({
    day: x.day, purpose: x.purpose, calls: x.calls, tokens_in: x.tokensIn, tokens_out: x.tokensOut,
    cost_minor: x.costMinor, currency: x.currency, avg_latency_ms: x.avgLatencyMs, error_pct: x.errorPct,
  }))
}
