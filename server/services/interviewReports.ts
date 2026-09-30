import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { withTenant, type TenantTx } from '../utils/withTenant'
import { resolveAudience } from './audience'
import { recordAudit } from './audit'
import { scopeCond, type Viewer } from './candidates'
import { CANDIDATES_ONLY } from './repo/people'
import { period, tenantTz } from './aiReports'
import type { Audience } from '../../shared/schemas/assignments'
import type { InterviewReportQuery } from '../../shared/schemas/interview'

/**
 * Отчёты ИИ-собеседования (`docs/v2/30-ai-interview.md` §9.1, §9.2, §9.6; `44` Р-AI2.5–Р-AI2.7):
 * «Воронка співбесід», «Згоди», «Вивантаження співбесід». Скоуп `interview.view` — те, кто видит
 * оценку ИИ (`30` §2); кандидаты — в области зрителя (`candidates.ts#scopeCond`: керівник точки —
 * только своих), наставник (объём проверки) отчётов не видит.
 *
 * **Отчёты ничего не решают о людях** (инвариант 18): воронка и согласия — счётчики без имён;
 * выгрузка называет кандидата, но несёт только числа, флаги и `agreement`. **Расшифровок,
 * обоснований, цитат и ссылок на аудио в выгрузке нет никогда** (`30` §9.6): вынос голосовых
 * ответов из системы не предусмотрен. Факт выгрузки файла — `audit_log` с числом строк.
 *
 * Фильтры: период (по дате в поясе тенанта), вакансия кандидата, точка вакансии, тест
 * собеседования (все версии сценария — решение о согласии принимается о тесте, `common.ts`).
 */

interface Filters { v: Viewer, q: InterviewReportQuery }

/** Сессия «завершена» — кандидат отправил ответы; дальше её путь — расшифровка, оценка или человек. */
const FINISHED_STATES = sql`('submitted', 'transcribing', 'scoring', 'scored', 'needs_human')`

const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round(part / whole * 1000) / 10 : null)

/**
 * Область зрителя и фильтры вакансии и точки; таблица — `users` без алиаса. Вид людей
 * (`CANDIDATES_ONLY`) каждый запрос называет сам, рядом с `join users` (инвариант 17).
 */
function candidateWhere({ v, q }: Filters): SQL {
  const scope = scopeCond(v)
  return sql`${scope ? sql`and ${scope}` : sql``}
    ${q.vacancyId ? sql`and users.vacancy_id = ${q.vacancyId}::uuid` : sql``}
    ${q.locationId ? sql`and exists (select 1 from vacancies vl where vl.id = users.vacancy_id and vl.location_id = ${q.locationId}::uuid)` : sql``}`
}

/** Тесты собеседования под фильтром — строки отчётов; удалённые тесты тоже: история остаётся. */
async function interviewQuizzes(tx: TenantTx, q: InterviewReportQuery): Promise<{ id: string, title: string, scenario: string | null }[]> {
  return await tx.execute(sql`
    select qz.id, qz.title,
           (select s.name from interview_scenarios s where s.quiz_id = qz.id order by (s.status = 'published') desc, s.version desc limit 1) as scenario
      from quizzes qz
     where qz.kind = 'interview' ${q.quizId ? sql`and qz.id = ${q.quizId}::uuid` : sql``}
     order by qz.title`) as unknown as { id: string, title: string, scenario: string | null }[]
}

// ── §9.1 Воронка собеседований ─────────────────────────────────────────────────────────────

export interface FunnelRow {
  quizId: string
  quiz: string
  scenario: string | null
  assigned: number
  agreed: number
  declined: number
  finished: number
  needsHuman: number
  avgScore: number | null
  medianMinutes: number | null
  agreedPct: number | null
  finishedPct: number | null
}

/**
 * «Воронка співбесід» (`30` §9.1): назначено · согласились · отказались · завершили ·
 * `needs_human` · средний балл · медиана длительности — по тесту собеседования (`44` Р-AI2.5).
 *
 * «Назначено» — когорта: кандидаты из аудитории назначений теста, созданных в периоде, плюс те,
 * кто принял первое решение по согласию в периоде (назначение могли переписать, а человек уже
 * прошёл экран согласия — выпасть из воронки он не должен). Дальше по когорте: согласились —
 * хоть раз дали согласие (отозвавшие — тоже: согласие было); отказались — последнее решение
 * «отказ»; завершили, `needs_human`, балл и длительность — по последней сессии кандидата.
 * Средний балл — только сессий `scored`: у `needs_human` числа ИИ нет по построению (`30` §4).
 */
export async function interviewFunnelReport(v: Viewer, q: InterviewReportQuery): Promise<{ rows: FunnelRow[], total: Omit<FunnelRow, 'quizId' | 'quiz' | 'scenario'> }> {
  const empty = { rows: [], total: { assigned: 0, agreed: 0, declined: 0, finished: 0, needsHuman: 0, avgScore: null, medianMinutes: null, agreedPct: null, finishedPct: null } }
  if (v.reviewOnly) return empty
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const tz = await tenantTz(tx, v.tenantId)
    const quizzes = await interviewQuizzes(tx, q)
    if (!quizzes.length) return empty
    const quizIds = quizzes.map(z => z.id)

    // Аудитория назначений периода — тем же разрешением, что у назначения (docs/15 §3.2)
    const asg = await tx.execute(sql`
      select a.subject_id as quiz_id, a.audience, a.exclude from assignments a
       where a.subject_type = 'test' and a.status <> 'draft'
         and a.subject_id in (select jsonb_array_elements_text(${JSON.stringify(quizIds)}::jsonb)::uuid)
         ${period(sql`a.created_at`, tz, q)}`) as unknown as { quiz_id: string, audience: Audience, exclude: Audience | null }[]
    const cohort: { quiz_id: string, user_id: string }[] = []
    for (const a of asg) {
      for (const userId of await resolveAudience(tx, a.audience, a.exclude)) cohort.push({ quiz_id: a.quiz_id, user_id: userId })
    }

    const rows = await tx.execute(sql`
      with first_dec as (
        select distinct on (ic.user_id, sc.quiz_id) sc.quiz_id, ic.user_id, ic.decided_at
          from interview_consents ic join interview_scenarios sc on sc.id = ic.scenario_id
         where sc.quiz_id in (select jsonb_array_elements_text(${JSON.stringify(quizIds)}::jsonb)::uuid)
         order by ic.user_id, sc.quiz_id, ic.decided_at, ic.created_at),
      raw as (
        select c.quiz_id, c.user_id from jsonb_to_recordset(${JSON.stringify(cohort)}::jsonb) as c(quiz_id uuid, user_id uuid)
        union
        select f.quiz_id, f.user_id from first_dec f where true ${period(sql`f.decided_at`, tz, q)}),
      cohort as (
        select raw.quiz_id, raw.user_id from raw join users on users.id = raw.user_id
         where true ${CANDIDATES_ONLY('users')} ${candidateWhere({ v, q })}),
      last_dec as (
        select distinct on (ic.user_id, sc.quiz_id) sc.quiz_id, ic.user_id, ic.decision
          from interview_consents ic join interview_scenarios sc on sc.id = ic.scenario_id
         where ic.user_id in (select user_id from cohort)
         order by ic.user_id, sc.quiz_id, ic.decided_at desc, ic.created_at desc),
      ever as (
        select distinct sc.quiz_id, ic.user_id
          from interview_consents ic join interview_scenarios sc on sc.id = ic.scenario_id
         where ic.decision in ('accepted', 'withdrawn') and ic.user_id in (select user_id from cohort)),
      ses as (
        select distinct on (s.candidate_id, sc.quiz_id) sc.quiz_id, s.candidate_id as user_id, s.state, s.ai_score, s.started_at, s.finished_at
          from interview_sessions s join interview_scenarios sc on sc.id = s.scenario_id
         where s.candidate_id in (select user_id from cohort)
         order by s.candidate_id, sc.quiz_id, s.created_at desc)
      select grouping(c.quiz_id) = 1 as is_total, c.quiz_id,
             count(*)::int as assigned,
             count(e.user_id)::int as agreed,
             count(*) filter (where d.decision = 'declined')::int as declined,
             count(*) filter (where s.state in ${FINISHED_STATES})::int as finished,
             count(*) filter (where s.state = 'needs_human')::int as needs_human,
             avg(s.ai_score) filter (where s.state = 'scored') as avg_score,
             percentile_cont(0.5) within group (order by extract(epoch from s.finished_at - s.started_at))
               filter (where s.state in ${FINISHED_STATES} and s.started_at is not null and s.finished_at is not null) as median_sec
        from cohort c
        left join last_dec d on d.quiz_id = c.quiz_id and d.user_id = c.user_id
        left join ever e on e.quiz_id = c.quiz_id and e.user_id = c.user_id
        left join ses s on s.quiz_id = c.quiz_id and s.user_id = c.user_id
       group by rollup (c.quiz_id)`) as unknown as {
      is_total: boolean, quiz_id: string | null, assigned: number, agreed: number, declined: number, finished: number, needs_human: number,
      avg_score: string | null, median_sec: number | null
    }[]

    const map = (r: typeof rows[number]) => ({
      assigned: r.assigned, agreed: r.agreed, declined: r.declined, finished: r.finished, needsHuman: r.needs_human,
      avgScore: r.avg_score === null ? null : Math.round(Number(r.avg_score) * 10) / 10,
      medianMinutes: r.median_sec === null ? null : Math.round(Number(r.median_sec) / 6) / 10,
      agreedPct: pct(r.agreed, r.assigned), finishedPct: pct(r.finished, r.agreed),
    })
    const byQuiz = new Map(rows.filter(r => !r.is_total).map(r => [r.quiz_id!, r]))
    const tot = rows.find(r => r.is_total)
    return {
      rows: quizzes.filter(z => byQuiz.has(z.id)).map(z => ({ quizId: z.id, quiz: z.title, scenario: z.scenario, ...map(byQuiz.get(z.id)!) })),
      total: tot ? map(tot) : empty.total,
    }
  })
}

export function funnelExportRows(r: Awaited<ReturnType<typeof interviewFunnelReport>>): Record<string, unknown>[] {
  return r.rows.map(x => ({
    quiz: x.quiz, scenario: x.scenario, assigned: x.assigned, agreed: x.agreed, declined: x.declined, finished: x.finished,
    needs_human: x.needsHuman, avg_score: x.avgScore, median_minutes: x.medianMinutes,
  }))
}

// ── §9.2 Согласия ──────────────────────────────────────────────────────────────────────────

export interface ConsentRow {
  vacancyId: string | null
  vacancy: string | null
  lang: string
  decisions: number
  accepted: number
  declined: number
  withdrawn: number
  declinedPct: number | null
  altHuman: number
  altText: number
}

/**
 * «Згоди» (`30` §9.2): доля отказов от ИИ по вакансиям и языку кандидата, распределение
 * выбранных альтернатив (`44` Р-AI2.6). Строка — последнее решение человека по тесту (решение
 * принимается о тесте, а не о версии сценария), попавшее в период; язык — язык текста согласия,
 * который человек прочитал (`interview_consents.lang`), — ровно то, что может «пугать». Отзыв
 * согласия — отдельная колонка: человек согласился, но передумал; в долю отказов не входит.
 */
export async function interviewConsentReport(v: Viewer, q: InterviewReportQuery): Promise<{ rows: ConsentRow[], alternatives: { human_interview: number, text_form: number } }> {
  const empty = { rows: [], alternatives: { human_interview: 0, text_form: 0 } }
  if (v.reviewOnly) return empty
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const tz = await tenantTz(tx, v.tenantId)
    const rows = await tx.execute(sql`
      with dec as (
        select distinct on (ic.user_id, sc.quiz_id) ic.user_id, ic.decision, ic.lang, ic.alternative_chosen, ic.decided_at
          from interview_consents ic join interview_scenarios sc on sc.id = ic.scenario_id
         where true ${q.quizId ? sql`and sc.quiz_id = ${q.quizId}::uuid` : sql``}
         order by ic.user_id, sc.quiz_id, ic.decided_at desc, ic.created_at desc)
      select vc.id as vacancy_id, vc.title as vacancy, d.lang,
             count(*)::int as decisions,
             count(*) filter (where d.decision = 'accepted')::int as accepted,
             count(*) filter (where d.decision = 'declined')::int as declined,
             count(*) filter (where d.decision = 'withdrawn')::int as withdrawn,
             count(*) filter (where d.decision = 'declined' and d.alternative_chosen = 'human_interview')::int as alt_human,
             count(*) filter (where d.decision = 'declined' and d.alternative_chosen = 'text_form')::int as alt_text
        from dec d
        join users on users.id = d.user_id
        left join vacancies vc on vc.id = users.vacancy_id
       where true ${CANDIDATES_ONLY('users')} ${candidateWhere({ v, q })} ${period(sql`d.decided_at`, tz, q)}
       group by vc.id, vc.title, d.lang
       order by count(*) filter (where d.decision = 'declined') desc, vc.title nulls last, d.lang`) as unknown as {
      vacancy_id: string | null, vacancy: string | null, lang: string, decisions: number, accepted: number, declined: number, withdrawn: number, alt_human: number, alt_text: number
    }[]
    return {
      rows: rows.map(r => ({
        vacancyId: r.vacancy_id, vacancy: r.vacancy, lang: r.lang, decisions: r.decisions, accepted: r.accepted, declined: r.declined,
        withdrawn: r.withdrawn, declinedPct: pct(r.declined, r.decisions), altHuman: r.alt_human, altText: r.alt_text,
      })),
      alternatives: {
        human_interview: rows.reduce((n, r) => n + r.alt_human, 0),
        text_form: rows.reduce((n, r) => n + r.alt_text, 0),
      },
    }
  })
}

export function consentExportRows(r: Awaited<ReturnType<typeof interviewConsentReport>>): Record<string, unknown>[] {
  return r.rows.map(x => ({
    vacancy: x.vacancy, lang: x.lang, decisions: x.decisions, accepted: x.accepted, declined: x.declined, withdrawn: x.withdrawn,
    declined_pct: x.declinedPct, alt_human_interview: x.altHuman, alt_text_form: x.altText,
  }))
}

// ── §9.6 Выгрузка собеседований ────────────────────────────────────────────────────────────

/** Потолок строк выгрузки — как у журнала ИИ (Р-AI.7): больше — сузить период. */
export const INTERVIEW_EXPORT_MAX = 10_000

export interface SessionExportRow {
  sessionId: string
  candidateId: string
  candidate: string
  quiz: string
  scenario: string
  scenarioVersion: number
  date: string
  state: string
  durationSec: number | null
  aiScore: number | null
  aiConfidence: number | null
  /** Балл ИИ и балл человека по каждому критерию — только числа (`30` §9.6). */
  criteria: { name: string, value: number | null, scaleMax: number, humanValue: number | null, agreement: string }[]
  flags: string[]
  agreement: { match: number, minor: number, major: number, pending: number }
  aiStub: boolean
}

/**
 * «Вивантаження співбесід» (`30` §9.6, `44` Р-AI2.7): кандидат, сценарий, дата, длительность,
 * баллы по критериям, уверенность, флаги, `agreement`. Выборка — только перечисленные колонки:
 * `transcript`, `prompt_text`, `rationale`, `evidence`, `media_id` в запрос не попадают вовсе,
 * чтобы их не вынесло ни экраном, ни файлом. Обезличенный кандидат — под своим обезличенным
 * именем: числа статистике нужны, человек уже не идентифицируется (`30` §7.9).
 */
export async function interviewSessionsReport(v: Viewer, q: InterviewReportQuery, opts: { audit?: { format: string } } = {}): Promise<{ rows: SessionExportRow[], truncated: boolean }> {
  if (v.reviewOnly) return { rows: [], truncated: false }
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const tz = await tenantTz(tx, v.tenantId)
    const raw = await tx.execute(sql`
      select s.id, s.candidate_id, users.full_name as candidate, qz.title as quiz, sc.name as scenario, sc.version,
             to_char((coalesce(s.started_at, s.created_at) at time zone ${tz}), 'YYYY-MM-DD HH24:MI') as date,
             s.state, extract(epoch from s.finished_at - s.started_at)::int as duration_sec,
             s.ai_score, s.ai_confidence, s.flags, s.ai_stub,
             coalesce((
               select jsonb_agg(jsonb_build_object('name', c.name_uk, 'value', cs.value, 'scaleMax', c.scale_max,
                                                   'humanValue', cs.human_value, 'agreement', cs.agreement) order by c.sort)
                 from interview_criterion_scores cs join interview_criteria c on c.id = cs.criterion_id
                where cs.session_id = s.id), '[]'::jsonb) as criteria
        from interview_sessions s
        join users on users.id = s.candidate_id
        join interview_scenarios sc on sc.id = s.scenario_id
        join quizzes qz on qz.id = sc.quiz_id
       where s.state not in ('created', 'consent_pending') ${CANDIDATES_ONLY('users')}
         ${candidateWhere({ v, q })}
         ${q.quizId ? sql`and sc.quiz_id = ${q.quizId}::uuid` : sql``}
         ${period(sql`coalesce(s.started_at, s.created_at)`, tz, q)}
       order by coalesce(s.started_at, s.created_at) desc, s.id
       limit ${INTERVIEW_EXPORT_MAX + 1}`) as unknown as {
      id: string, candidate_id: string, candidate: string, quiz: string, scenario: string, version: number, date: string, state: string,
      duration_sec: number | null, ai_score: string | null, ai_confidence: string | null, flags: { code: string }[] | null, ai_stub: boolean,
      criteria: { name: string, value: string | number | null, scaleMax: string | number, humanValue: string | number | null, agreement: string }[]
    }[]
    const page = raw.slice(0, INTERVIEW_EXPORT_MAX)
    if (opts.audit) {
      await recordAudit(tx, {
        tenantId: v.tenantId, actorId: v.actorId, action: 'interview.sessions.export', entity: 'interview_session', entityId: null,
        after: { rows: page.length, format: opts.audit.format, filters: { from: q.from ?? null, to: q.to ?? null, vacancyId: q.vacancyId ?? null, locationId: q.locationId ?? null, quizId: q.quizId ?? null } },
      })
    }
    const num = (x: string | number | null) => (x === null ? null : Number(x))
    return {
      truncated: raw.length > INTERVIEW_EXPORT_MAX,
      rows: page.map((r) => {
        const criteria = r.criteria.map(c => ({ name: c.name, value: num(c.value), scaleMax: Number(c.scaleMax), humanValue: num(c.humanValue), agreement: c.agreement }))
        const agreement = { match: 0, minor: 0, major: 0, pending: 0 }
        for (const c of criteria) if (c.agreement in agreement) agreement[c.agreement as keyof typeof agreement]++
        return {
          sessionId: r.id, candidateId: r.candidate_id, candidate: r.candidate, quiz: r.quiz, scenario: r.scenario, scenarioVersion: r.version,
          date: r.date, state: r.state, durationSec: r.duration_sec, aiScore: num(r.ai_score), aiConfidence: num(r.ai_confidence),
          criteria, flags: [...new Set((r.flags ?? []).map(f => f.code))], agreement, aiStub: r.ai_stub,
        }
      }),
    }
  })
}

export function sessionsExportRows(r: Awaited<ReturnType<typeof interviewSessionsReport>>): Record<string, unknown>[] {
  return r.rows.map(x => ({
    candidate: x.candidate, quiz: x.quiz, scenario: `${x.scenario} (v${x.scenarioVersion})`, date: x.date, state: x.state,
    duration_min: x.durationSec === null ? null : Math.round(x.durationSec / 6) / 10,
    ai_score: x.aiScore, ai_confidence: x.aiConfidence,
    criteria: x.criteria.map(c => `${c.name}: ${c.value ?? '—'}/${c.scaleMax}${c.humanValue !== null ? ` (human ${c.humanValue})` : ''}`).join('; '),
    flags: x.flags.join(', '),
    agreement: `match ${x.agreement.match}, minor ${x.agreement.minor}, major ${x.agreement.major}, pending ${x.agreement.pending}`,
    ai_stub: x.aiStub,
  }))
}
