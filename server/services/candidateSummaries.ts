import { randomBytes } from 'node:crypto'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { candidateScores, candidateSummaries, interviewConsents, interviewCriteria, interviewCriterionScores, interviewScenarios, interviewSessions, users, vacancies } from '../db/schema'
import { db } from '../db/client'
import { withTenant, type TenantTx } from '../utils/withTenant'
import { keysetAfter, keysetAt } from '../utils/keyset'
import { KEYSETS, encodeKeyset } from '../../shared/domain/keyset'
import { formatDate, resolveLocale, type Locale } from '../../shared/domain/dateFormat'
import { confidenceWord } from '../../shared/domain/interview'
import {
  SUMMARY_CAVEAT, SUMMARY_SHARE_DAYS, autoSendBlock, autoSendDueAt, candidateView, checkPoints, defaultSections,
  disclaimerLine, incompleteItems, summaryCompleteness, summaryDisclaimer,
  type AutoSendBlock, type AutoSendRule, type SummaryBody, type SummaryCriterion, type SummaryInterview, type SummaryProgressItem, type SummaryScoreItem,
} from '../../shared/domain/candidateSummary'
import type { CandidateScoreKind, CandidateSummaryChannel, CandidateSummarySection, CandidateSummaryState } from '../../shared/enums'
import type { CandidateSummaryListQuery, CandidateSummaryPatchInput } from '../../shared/schemas/candidateSummaries'
import { recordAudit } from './audit'
import { candidateVisible, type Viewer } from './candidates'
import { personById } from './repo/people'
import { readSettings } from './settings'
import { enqueueNotification, tenantAdminIds } from './notifications'
import { callModel } from './ai/gateway'
import { aiUnavailable } from './ai/policy'
import { SUMMARY_POINTS_PROMPT, type SummaryPointsInput } from './ai/prompts'
import { effectiveLimits } from './tenantLimits'
import { enqueueForTenant } from './tenantQueue'
import { hitRateLimit } from './rateLimit'
import { alignDelay, ipHash } from './publicApply'

/**
 * Підсумок кандидата (`docs/v2/30-ai-interview.md` §1 (2), §3.5, §4, §5.4, §7.14, §7.15, §8, §10,
 * §11, §12 п. 4, 8; план `45` PR-29).
 *
 * Документ компилируется из данных — кто и на какую вакансию, пройденное и результаты, оценки с
 * авторами, собеседование по критериям с обоснованием и цитатой, что не пройдено, техпаспорт — и
 * одной генеративной секции «сильные стороны и зоны риска», всегда с оговоркой. **Строка
 * «Документ сформовано автоматично» входит в тело всегда** и держится CHECK'ом таблицы: её не
 * снимает ни выбор секций, ни правка текста, ни настройка тенанта (`30` §13 к. 14).
 *
 * **ИИ не принимает решений о людях** (инвариант 18): документ не содержит рекомендации нанять
 * или отказать — генеративная секция со словами решения отклоняется (`checkPoints`), и документ
 * собирается без неё. Авто-отправка — правило тенанта, а не решение модели: порог по оценке,
 * выбранной человеком, обязательная ненулевая задержка, в течение которой рекрутер видит и может
 * отменить отправку (§7.15 [решение]), и проверки перед отправкой (отказ, отзыв согласия,
 * непроверенная низкая уверенность).
 *
 * Версии: новая генерация — `version + 1`; прежние версии видны рекрутеру и по ссылке недоступны
 * (§4): отправленная прежняя версия отзывается с причиной `superseded`, запланированная
 * авто-отправка прежней — снимается. Кандидат видит документ по ссылке без входа — публичный
 * контур (`publicSummary`): тенант выводится из токена функцией `SECURITY DEFINER`, ответ без ПД
 * третьих лиц, неизвестный токен — `404` с выровненным временем.
 */

export interface Ctx { tenantId: string, actorId: string }

type Row = typeof candidateSummaries.$inferSelect

const SYSTEM_ACTOR: string | null = null

// ── Представление ────────────────────────────────────────────────────────────────────────

export interface SummaryView {
  id: string
  candidateId: string
  version: number
  state: CandidateSummaryState
  completeness: 'full' | 'partial'
  lang: Locale
  generatedBy: string
  sections: CandidateSummarySection[]
  /** Тело целиком — рекрутеру; `null` — стёрто отзывом согласия или обезличиванием. */
  body: SummaryBody | null
  /** «Документ сформовано автоматично… Оцінки програми перевірено людиною: так/ні.» — одной строкой. */
  disclaimerLine: string | null
  isLatest: boolean
  sentAt: string | null
  sentChannel: CandidateSummaryChannel | null
  /** Ссылка для кандидата — только тому, кто вправе отправлять (`summary.send`). */
  shareUrl: string | null
  shareExpiresAt: string | null
  revokedAt: string | null
  revokeReason: string | null
  redactedAt: string | null
  autoSend: { dueAt: string | null, cancelledAt: string | null, rule: Record<string, unknown> | null }
  editedAt: string | null
  createdAt: string
}

export function shareUrlOf(token: string): string {
  return `${(process.env.APP_URL ?? '').replace(/\/$/, '')}/summary/${token}`
}

function toView(r: Row, latestVersion: number, canSend: boolean): SummaryView {
  const body = r.redactedAt ? null : r.body as SummaryBody
  return {
    id: r.id,
    candidateId: r.candidateId,
    version: r.version,
    state: r.state as CandidateSummaryState,
    completeness: r.completeness as 'full' | 'partial',
    lang: resolveLocale(r.lang),
    generatedBy: r.generatedBy,
    sections: (r.sections as CandidateSummarySection[]) ?? [],
    body,
    disclaimerLine: body ? disclaimerLine(body.disclaimer) : null,
    isLatest: r.version === latestVersion,
    sentAt: r.sentAt?.toISOString() ?? null,
    sentChannel: r.sentChannel as CandidateSummaryChannel | null,
    shareUrl: canSend && r.shareToken && r.state === 'sent' ? shareUrlOf(r.shareToken) : null,
    shareExpiresAt: r.shareExpiresAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    revokeReason: r.revokeReason,
    redactedAt: r.redactedAt?.toISOString() ?? null,
    autoSend: { dueAt: r.autoSendDueAt?.toISOString() ?? null, cancelledAt: r.autoSendCancelledAt?.toISOString() ?? null, rule: r.autoSendRule as Record<string, unknown> | null },
    editedAt: r.editedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }
}

async function latestVersionOf(tx: TenantTx, candidateId: string): Promise<number> {
  const [r] = await tx.select({ v: sql<number>`coalesce(max(${candidateSummaries.version}), 0)::int` }).from(candidateSummaries)
    .where(eq(candidateSummaries.candidateId, candidateId))
  return Number(r?.v ?? 0)
}

// ── Сборка документа (`30` §7.14) ─────────────────────────────────────────────────────────

interface Person { fullName: string, kind: string, vacancyId: string | null, commLanguage: string | null, email: string | null, candidateState: string | null, anonymizedAt: Date | null }

async function personOf(tx: TenantTx, candidateId: string): Promise<Person | null> {
  const [p] = await personById(tx, {
    fullName: users.fullName, kind: users.kind, vacancyId: users.vacancyId, commLanguage: users.commLanguage,
    email: users.email, candidateState: users.candidateState, anonymizedAt: users.anonymizedAt,
  }, candidateId) as unknown as Person[]
  return p ?? null
}

const ATTEMPT_STATUS: Record<string, string> = { passed: 'done', failed: 'failed', expired: 'failed', review: 'in_progress', in_progress: 'in_progress' }
const WORKSHOP_STATUS: Record<string, string> = { accepted: 'done', rejected: 'failed', expired: 'failed' }

/**
 * Пройденное и результаты (`30` §7.14 п. 2, `28` §5.3 «Проходження»): курсы — записями и их
 * статусом из пяти канонических, тесты — последней попыткой (кроме собеседования: оно своей
 * секцией), практикумы — последней сдачей.
 */
async function progressOf(tx: TenantTx, candidateId: string): Promise<SummaryProgressItem[]> {
  const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null)
  const courses = await tx.execute(sql`
    select c.title, e.status, e.score::float8 as score, e.completed_at
      from enrollments e join courses c on c.id = e.subject_id
     where e.user_id = ${candidateId}::uuid and e.cancelled_at is null and e.status <> 'not_assigned' and e.subject_type = 'course'
     order by e.created_at, e.id limit 100`) as unknown as { title: string, status: string, score: number | null, completed_at: Date | string | null }[]
  const tests = await tx.execute(sql`
    select distinct on (a.quiz_id) q.title, a.status, a.score::float8 as score, coalesce(a.graded_at, a.submitted_at) as finished_at
      from attempts a join quizzes q on q.id = a.quiz_id
     where a.user_id = ${candidateId}::uuid and q.kind <> 'interview' and a.status <> 'annulled'
     order by a.quiz_id, a.attempt_no desc limit 100`) as unknown as { title: string, status: string, score: number | null, finished_at: Date | string | null }[]
  const works = await tx.execute(sql`
    select distinct on (s.workshop_id) w.title, s.status, s.score::float8 as score, s.reviewed_at
      from workshop_submissions s join workshops w on w.id = s.workshop_id
     where s.user_id = ${candidateId}::uuid and s.status <> 'draft'
     order by s.workshop_id, s.attempt_no desc limit 100`) as unknown as { title: string, status: string, score: number | null, reviewed_at: Date | string | null }[]
  return [
    ...courses.map(c => ({ title: c.title, kind: 'course', status: c.status, score: c.score === null ? null : Number(c.score), finishedAt: iso(c.completed_at) })),
    ...tests.map(t => ({ title: t.title, kind: 'test', status: ATTEMPT_STATUS[t.status] ?? 'in_progress', score: t.score === null ? null : Number(t.score), finishedAt: iso(t.finished_at) })),
    ...works.map(w => ({ title: w.title, kind: 'workshop', status: WORKSHOP_STATUS[w.status] ?? 'in_progress', score: w.score === null ? null : Number(w.score), finishedAt: iso(w.reviewed_at) })),
  ]
}

/** Действующие оценки четырёх видов с авторами и датами (`30` §7.14 п. 3, `28` §3.4). */
async function scoresOf(tx: TenantTx, candidateId: string): Promise<SummaryScoreItem[]> {
  const rows = await tx.select({ s: candidateScores, authorName: users.fullName }).from(candidateScores)
    .leftJoin(users, eq(users.id, candidateScores.authorId))
    .where(and(eq(candidateScores.candidateId, candidateId), eq(candidateScores.isCurrent, true)))
    .orderBy(asc(candidateScores.kind))
  return rows.map(r => ({
    kind: r.s.kind as CandidateScoreKind,
    value: r.s.valueNum === null ? null : Number(r.s.valueNum),
    authorName: r.s.authorId ? r.authorName : null,
    at: r.s.createdAt.toISOString(),
    aiStub: r.s.aiStub,
  }))
}

/** Последнее завершённое собеседование: по критерию балл, обоснование, ключевая цитата (`30` §7.14 п. 4). */
async function interviewOf(tx: TenantTx, candidateId: string): Promise<{ interview: SummaryInterview | null, humanChecked: boolean, confidence: number | null, model: { name: string, promptVersion: string } | null }> {
  const [s] = await tx.select({ s: interviewSessions, scenarioName: interviewScenarios.name }).from(interviewSessions)
    .innerJoin(interviewScenarios, eq(interviewScenarios.id, interviewSessions.scenarioId))
    .where(and(eq(interviewSessions.candidateId, candidateId), sql`${interviewSessions.state} in ('scored', 'needs_human')`, isNull(interviewSessions.redactedAt)))
    .orderBy(desc(interviewSessions.finishedAt), desc(interviewSessions.createdAt)).limit(1)
  if (!s) return { interview: null, humanChecked: false, confidence: null, model: null }
  const criteria = await tx.select().from(interviewCriteria).where(eq(interviewCriteria.scenarioId, s.s.scenarioId)).orderBy(asc(interviewCriteria.sort))
  const scores = await tx.select().from(interviewCriterionScores).where(eq(interviewCriterionScores.sessionId, s.s.id))
  const by = new Map(scores.map(x => [x.criterionId, x]))
  const [call] = await tx.execute(sql`
    select c.model_name, c.prompt_version from interview_criterion_scores ics join ai_calls c on c.id = ics.ai_call_id
     where ics.session_id = ${s.s.id}::uuid limit 1`) as unknown as { model_name: string, prompt_version: string }[]
  const list: SummaryCriterion[] = criteria.map((c) => {
    const x = by.get(c.id)
    const evidence = (x?.evidence ?? []) as { quote?: string }[]
    return {
      name: c.nameUk,
      value: x && x.value !== null ? Number(x.value) : null,
      scaleMax: Number(c.scaleMax),
      humanValue: x && x.humanValue !== null ? Number(x.humanValue) : null,
      rationale: x?.rationale ?? null,
      quote: evidence[0]?.quote ?? null,
    }
  })
  const confidence = s.s.aiConfidence === null ? null : Number(s.s.aiConfidence)
  return {
    interview: {
      scenarioName: s.scenarioName,
      finishedAt: s.s.finishedAt?.toISOString() ?? null,
      aiScore: s.s.aiScore === null ? null : Number(s.s.aiScore),
      confidenceWord: confidenceWord(confidence),
      aiStub: s.s.aiStub,
      needsHuman: s.s.state === 'needs_human',
      criteria: list,
    },
    humanChecked: scores.some(x => x.humanAt !== null),
    confidence,
    model: call ? { name: call.model_name, promptVersion: call.prompt_version } : null,
  }
}

async function vacancyTitle(tx: TenantTx, vacancyId: string | null): Promise<string | null> {
  if (!vacancyId) return null
  const [v] = await tx.select({ title: vacancies.title }).from(vacancies).where(eq(vacancies.id, vacancyId))
  return v?.title ?? null
}

export type BuildResult
  = | { ok: true, summary: SummaryView }
    | { ok: false, code: 'not_found' | 'no_data' }

/**
 * Новая версия Підсумку (`30` §10 `POST /candidate-summaries`, §11 `summary.build`): данные
 * секций — одной транзакцией, строка встаёт `draft`; генеративная секция — вызовом модели вне
 * транзакции (§7.14 п. 5), затем `ready`. Модель недоступна, ИИ не действует или ответ со словами
 * решения — секция пустая с пометкой, документ всё равно собран: без ИИ Підсумок остаётся
 * документом из данных.
 */
export async function buildSummaryFor(tenantId: string, actorId: string | null, candidateId: string, opts: { sections?: CandidateSummarySection[], reason?: string } = {}): Promise<BuildResult> {
  const draft = await withTenant(tenantId, actorId, async (tx) => {
    const person = await personOf(tx, candidateId)
    if (!person || person.anonymizedAt) return { ok: false as const, code: 'not_found' as const }
    const progress = await progressOf(tx, candidateId)
    const scores = await scoresOf(tx, candidateId)
    const iv = await interviewOf(tx, candidateId)
    if (!progress.length && !scores.length && !iv.interview) return { ok: false as const, code: 'no_data' as const }

    const lang = resolveLocale(person.commLanguage)
    const completeness = summaryCompleteness(progress)
    const aiStub = !!iv.interview?.aiStub || scores.some(s => s.aiStub)
    const body: SummaryBody = {
      candidate: { fullName: person.fullName, vacancyTitle: await vacancyTitle(tx, person.vacancyId) },
      progress: { items: progress },
      scores: { items: scores },
      interview: iv.interview,
      strengthsRisks: { status: 'unavailable', strengths: [], risks: [], caveat: SUMMARY_CAVEAT[lang], aiStub: false },
      incomplete: { items: incompleteItems(progress) },
      passport: { generatedAt: new Date().toISOString(), model: iv.model?.name ?? null, promptVersion: iv.model?.promptVersion ?? null, humanChecked: iv.humanChecked, aiStub },
      disclaimer: summaryDisclaimer(lang, iv.humanChecked),
    }

    const version = (await latestVersionOf(tx, candidateId)) + 1
    // Прежние версии по ссылке недоступны (§4): отправленная отзывается, запланированная снимается
    await tx.update(candidateSummaries).set({ state: 'revoked', revokedAt: new Date(), revokeReason: 'superseded', updatedAt: new Date() })
      .where(and(eq(candidateSummaries.candidateId, candidateId), eq(candidateSummaries.state, 'sent')))
    await tx.update(candidateSummaries).set({ autoSendDueAt: null, updatedAt: new Date() })
      .where(and(eq(candidateSummaries.candidateId, candidateId), sql`${candidateSummaries.autoSendDueAt} is not null`))
    const [row] = await tx.insert(candidateSummaries).values({
      tenantId,
      candidateId,
      vacancyId: person.vacancyId,
      version,
      state: 'draft',
      completeness,
      body,
      sections: opts.sections ?? defaultSections(completeness),
      lang,
      generatedBy: 'ai',
    }).returning()
    await recordAudit(tx, {
      tenantId, actorId, action: 'summary.build', entity: 'candidate_summary', entityId: row!.id,
      after: { candidateId, version, completeness, reason: opts.reason ?? 'manual' },
    })
    return { ok: true as const, row: row!, lang, progress, scores, criteria: iv.interview?.criteria ?? [] }
  })
  if (!draft.ok) return draft

  const points = await generatePoints(tenantId, actorId, draft.row.id, candidateId, {
    lang: draft.lang,
    strict: false,
    criteria: draft.criteria.map(c => ({ name: c.name, value: c.value, scaleMax: c.scaleMax, humanValue: c.humanValue, rationale: c.rationale })),
    scores: draft.scores.map(s => ({ kind: s.kind, value: s.value })),
    progress: draft.progress.map(p => ({ title: p.title, status: p.status, score: p.score })),
  })

  const summary = await withTenant(tenantId, actorId, async (tx) => {
    const [cur] = await tx.select().from(candidateSummaries).where(eq(candidateSummaries.id, draft.row.id)).for('update')
    if (!cur || cur.redactedAt || cur.state !== 'draft') return cur ?? draft.row
    const body = cur.body as SummaryBody
    const next: SummaryBody = points.ok
      ? { ...body, strengthsRisks: { ...body.strengthsRisks, status: 'ready', strengths: points.strengths, risks: points.risks, aiStub: points.stub }, passport: { ...body.passport, aiStub: body.passport.aiStub || points.stub } }
      : body
    const [row] = await tx.update(candidateSummaries).set({
      state: 'ready', body: next, aiCallId: points.ok ? points.callId : null, updatedAt: new Date(),
    }).where(eq(candidateSummaries.id, cur.id)).returning()
    return row!
  })
  return { ok: true, summary: await withTenant(tenantId, actorId, async tx => toView(summary, await latestVersionOf(tx, candidateId), true)) }
}

type PointsResult = { ok: true, strengths: string[], risks: string[], callId: number, stub: boolean } | { ok: false, reason: string }

async function generatePoints(tenantId: string, actorId: string | null, summaryId: string, candidateId: string, input: SummaryPointsInput): Promise<PointsResult> {
  // Генеративная секция — функция ИИ: при истёкшем или выключенном ИИ её нет, документ собирается (§7.20)
  if (aiUnavailable((await effectiveLimits(tenantId)).subscription)) return { ok: false, reason: 'ai_unavailable' }
  try {
    const opts = { ref: { kind: 'summary' as const, id: summaryId }, subjectUserId: candidateId }
    let call = await callModel({ tenantId, actorId }, SUMMARY_POINTS_PROMPT, input, opts)
    if (!call.ok) return { ok: false, reason: call.code }
    let checked = checkPoints(call.output as { strengths?: unknown, risks?: unknown })
    if (!checked.ok) {
      call = await callModel({ tenantId, actorId }, SUMMARY_POINTS_PROMPT, { ...input, strict: true }, { ...opts, tryNo: 2 })
      if (!call.ok) return { ok: false, reason: call.code }
      checked = checkPoints(call.output as { strengths?: unknown, risks?: unknown })
    }
    if (!checked.ok) return { ok: false, reason: checked.problem }
    return { ok: true, strengths: checked.strengths, risks: checked.risks, callId: call.callId, stub: call.model.driver === 'stub' }
  }
  catch (err) {
    console.error('[summary.points]', err)
    return { ok: false, reason: 'error' }
  }
}

export async function buildSummary(v: Viewer, candidateId: string, sections?: CandidateSummarySection[]): Promise<BuildResult> {
  if (!await candidateVisible(v, candidateId)) return { ok: false, code: 'not_found' }
  return buildSummaryFor(v.tenantId, v.actorId, candidateId, { sections })
}

// ── Чтение ──────────────────────────────────────────────────────────────────────────────

export async function getSummary(v: Viewer, id: string, canSend: boolean): Promise<SummaryView | null> {
  const row = await withTenant(v.tenantId, v.actorId, async tx => (await tx.select().from(candidateSummaries).where(eq(candidateSummaries.id, id)))[0] ?? null)
  if (!row || !await candidateVisible(v, row.candidateId)) return null
  return withTenant(v.tenantId, v.actorId, async tx => toView(row, await latestVersionOf(tx, row.candidateId), canSend))
}

/**
 * Список Підсумків (`30` §10 `GET /candidate-summaries`). Роль с областью «точка» видит только
 * своих кандидатов — без `candidateId` ей список пуст, с чужим — `null` (`404`).
 */
export async function listSummaries(v: Viewer, q: CandidateSummaryListQuery, canSend: boolean): Promise<{ items: SummaryView[], nextCursor: string | null } | null> {
  if (q.candidateId && !await candidateVisible(v, q.candidateId)) return null
  if (!q.candidateId && v.locations !== null) return { items: [], nextCursor: null }
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const rows = await tx.select({ r: candidateSummaries, cursorAt: keysetAt(candidateSummaries.createdAt) }).from(candidateSummaries)
      .where(and(
        q.candidateId ? eq(candidateSummaries.candidateId, q.candidateId) : undefined,
        q.state ? eq(candidateSummaries.state, q.state) : undefined,
        keysetAfter(KEYSETS.candidateSummaries, q.cursor, [candidateSummaries.createdAt, candidateSummaries.id], 'desc'),
      ))
      .orderBy(desc(candidateSummaries.createdAt), desc(candidateSummaries.id))
      .limit(q.limit + 1)
    const page = rows.slice(0, q.limit)
    const latest = new Map<string, number>()
    for (const { r } of page) if (!latest.has(r.candidateId)) latest.set(r.candidateId, await latestVersionOf(tx, r.candidateId))
    const last = rows.length > q.limit ? page[page.length - 1] : undefined
    return {
      items: page.map(({ r }) => toView(r, latest.get(r.candidateId)!, canSend)),
      nextCursor: last ? encodeKeyset(KEYSETS.candidateSummaries, [last.cursorAt, last.r.id]) : null,
    }
  })
}

// ── Правка (`30` §5.4 «Редагувати», §10 `PATCH`) ─────────────────────────────────────────

export type PatchResult
  = | { ok: true, summary: SummaryView }
    | { ok: false, code: 'not_found' | 'sent' | 'not_editable' }

/**
 * Правка: включённые секции и текст генеративной секции — `generated_by = 'ai_edited'`. Строку
 * «Документ сформовано автоматично» правка не трогает: её нет в контракте, тело собирается
 * сервером, CHECK таблицы не даёт её снять. Отправленный документ не правится (`409 summary.sent`).
 */
export async function patchSummary(v: Viewer, id: string, input: CandidateSummaryPatchInput, canSend: boolean): Promise<PatchResult> {
  const current = await withTenant(v.tenantId, v.actorId, async tx => (await tx.select().from(candidateSummaries).where(eq(candidateSummaries.id, id)))[0] ?? null)
  if (!current || !await candidateVisible(v, current.candidateId)) return { ok: false, code: 'not_found' }
  return withTenant(v.tenantId, v.actorId, async (tx): Promise<PatchResult> => {
    const [r] = await tx.select().from(candidateSummaries).where(eq(candidateSummaries.id, id)).for('update')
    if (!r) return { ok: false, code: 'not_found' }
    if (r.state === 'sent') return { ok: false, code: 'sent' }
    if (r.state !== 'ready' || r.redactedAt) return { ok: false, code: 'not_editable' }
    const body = r.body as SummaryBody
    const textChanged = input.strengths !== undefined || input.risks !== undefined
    const next: SummaryBody = textChanged
      ? {
          ...body,
          strengthsRisks: {
            ...body.strengthsRisks,
            status: 'ready',
            strengths: input.strengths ?? body.strengthsRisks.strengths,
            risks: input.risks ?? body.strengthsRisks.risks,
          },
        }
      : body
    const [row] = await tx.update(candidateSummaries).set({
      body: next,
      sections: input.sections ?? r.sections,
      generatedBy: textChanged ? 'ai_edited' : r.generatedBy,
      editedBy: v.actorId,
      editedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(candidateSummaries.id, id)).returning()
    await recordAudit(tx, {
      tenantId: v.tenantId, actorId: v.actorId, action: 'summary.edit', entity: 'candidate_summary', entityId: id,
      before: { sections: r.sections, strengthsRisks: body.strengthsRisks }, after: { sections: row!.sections, strengthsRisks: next.strengthsRisks },
    })
    return { ok: true, summary: toView(row!, await latestVersionOf(tx, r.candidateId), canSend) }
  })
}

// ── Отправка (`30` §5.4, §7.15, §8 `interview.result_ready`, §10 `…/send`) ───────────────

export type SendResult
  = | { ok: true, sentAt: string, shareToken: string, shareUrl: string, shareExpiresAt: string, channel: CandidateSummaryChannel }
    | { ok: false, code: 'not_found' | 'not_ready' | 'not_latest' | 'not_candidate' | 'consent_withdrawn' | 'contact_missing' }

/** Отозвал ли кандидат согласие на собеседование — последнее решение по согласию (`30` §7.6, §7.15). */
async function consentWithdrawn(tx: TenantTx, candidateId: string): Promise<boolean> {
  const [c] = await tx.select({ decision: interviewConsents.decision }).from(interviewConsents)
    .where(eq(interviewConsents.userId, candidateId))
    .orderBy(desc(interviewConsents.decidedAt), desc(interviewConsents.createdAt)).limit(1)
  return c?.decision === 'withdrawn'
}

/**
 * Отправка — в транзакции вызывающего: и рекрутером («Надіслати кандидату» / «Скопіювати
 * посилання»), и авто-отправкой. Ссылка живёт 30 дней (§7.15); письмо кандидату — через очередь
 * уведомлений, то есть в его окне 09:00–20:00 (сквозная проверка 10).
 */
async function sendTx(tx: TenantTx, tenantId: string, actorId: string | null, r: Row, channel: CandidateSummaryChannel, trigger: 'manual' | 'auto'): Promise<SendResult> {
  if (r.version !== await latestVersionOf(tx, r.candidateId)) return { ok: false, code: 'not_latest' }
  if (r.redactedAt || !['ready', 'sent'].includes(r.state)) return { ok: false, code: 'not_ready' }
  const person = await personOf(tx, r.candidateId)
  // Нанятый до отправки — документ больше не отправляется (§12 п. 8); обезличенный — тем более
  if (!person || person.kind !== 'candidate' || person.anonymizedAt) return { ok: false, code: 'not_candidate' }
  if (await consentWithdrawn(tx, r.candidateId)) return { ok: false, code: 'consent_withdrawn' }
  if (channel === 'email' && !person.email) return { ok: false, code: 'contact_missing' }

  const now = new Date()
  const again = r.state === 'sent' && !!r.shareToken && !!r.shareExpiresAt && r.shareExpiresAt > now
  const token = again ? r.shareToken! : randomBytes(24).toString('base64url')
  const expires = again ? r.shareExpiresAt! : new Date(now.getTime() + SUMMARY_SHARE_DAYS * 86_400_000)
  await tx.update(candidateSummaries).set({
    state: 'sent',
    shareToken: token,
    shareExpiresAt: expires,
    sentAt: again ? r.sentAt : now,
    sentChannel: again && r.sentChannel === 'email' ? 'email' : channel,
    sentBy: actorId,
    autoSendDueAt: null,
    updatedAt: now,
  }).where(eq(candidateSummaries.id, r.id))

  const url = shareUrlOf(token)
  if (channel === 'email') {
    const lang = resolveLocale(r.lang)
    await enqueueNotification(tx, {
      tenantId,
      userId: r.candidateId,
      code: 'interview_result_ready',
      channel: 'email',
      payload: { url, until: formatDate(expires, lang), disclaimer: (r.body as SummaryBody).disclaimer?.text ?? '' },
      dedupKey: `interview_result_ready:${r.id}:${now.getTime()}`,
    })
  }
  await recordAudit(tx, {
    tenantId, actorId, action: 'summary.send', entity: 'candidate_summary', entityId: r.id,
    after: { candidateId: r.candidateId, version: r.version, channel, trigger, shareExpiresAt: expires.toISOString(), again },
  })
  return { ok: true, sentAt: (again ? r.sentAt! : now).toISOString(), shareToken: token, shareUrl: url, shareExpiresAt: expires.toISOString(), channel }
}

export async function sendSummary(v: Viewer, id: string, channel: CandidateSummaryChannel): Promise<SendResult> {
  const current = await withTenant(v.tenantId, v.actorId, async tx => (await tx.select().from(candidateSummaries).where(eq(candidateSummaries.id, id)))[0] ?? null)
  if (!current || !await candidateVisible(v, current.candidateId)) return { ok: false, code: 'not_found' }
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const [r] = await tx.select().from(candidateSummaries).where(eq(candidateSummaries.id, id)).for('update')
    return r ? sendTx(tx, v.tenantId, v.actorId, r, channel, 'manual') : { ok: false as const, code: 'not_found' as const }
  })
}

export type RevokeResult = { ok: true } | { ok: false, code: 'not_found' | 'not_revocable' }

/** «Відкликати доступ» (`30` §4 `ready|sent → revoked`): ссылка перестаёт открываться сразу. */
export async function revokeSummary(v: Viewer, id: string, reason: string): Promise<RevokeResult> {
  const current = await withTenant(v.tenantId, v.actorId, async tx => (await tx.select().from(candidateSummaries).where(eq(candidateSummaries.id, id)))[0] ?? null)
  if (!current || !await candidateVisible(v, current.candidateId)) return { ok: false, code: 'not_found' }
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const [r] = await tx.update(candidateSummaries).set({ state: 'revoked', revokedAt: new Date(), revokeReason: reason, autoSendDueAt: null, updatedAt: new Date() })
      .where(and(eq(candidateSummaries.id, id), sql`${candidateSummaries.state} in ('ready', 'sent')`)).returning({ id: candidateSummaries.id, state: candidateSummaries.state })
    if (!r) return { ok: false as const, code: 'not_revocable' as const }
    await recordAudit(tx, { tenantId: v.tenantId, actorId: v.actorId, action: 'summary.revoke', entity: 'candidate_summary', entityId: id, before: { state: current.state }, after: { reason } })
    return { ok: true as const }
  })
}

// ── Авто-отправка (`30` §6.5, §7.15, §8 `summary.auto_send_scheduled`, §11) ──────────────

export type CancelResult = { ok: true } | { ok: false, code: 'not_found' | 'not_scheduled' }

/** Отмена авто-отправки до `auto_send_due_at` (`30` §13 к. 13): документ остаётся `ready`, сверка его заново не ставит. */
export async function cancelAutoSend(v: Viewer, id: string): Promise<CancelResult> {
  const current = await withTenant(v.tenantId, v.actorId, async tx => (await tx.select().from(candidateSummaries).where(eq(candidateSummaries.id, id)))[0] ?? null)
  if (!current || !await candidateVisible(v, current.candidateId)) return { ok: false, code: 'not_found' }
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const [r] = await tx.update(candidateSummaries).set({ autoSendDueAt: null, autoSendCancelledAt: new Date(), autoSendCancelledBy: v.actorId, updatedAt: new Date() })
      .where(and(eq(candidateSummaries.id, id), eq(candidateSummaries.state, 'ready'), sql`${candidateSummaries.autoSendDueAt} > now()`))
      .returning({ id: candidateSummaries.id })
    if (!r) return { ok: false as const, code: 'not_scheduled' as const }
    await recordAudit(tx, { tenantId: v.tenantId, actorId: v.actorId, action: 'summary.auto_send_cancel', entity: 'candidate_summary', entityId: id, before: { dueAt: current.autoSendDueAt }, after: null })
    return { ok: true as const }
  })
}

interface Facts { person: Person | null, consentWithdrawn: boolean, humanChecked: boolean, aiConfidence: number | null, score: { id: string, value: number | null } | null }

async function factsOf(tx: TenantTx, candidateId: string, kind: CandidateScoreKind): Promise<Facts> {
  const person = await personOf(tx, candidateId)
  const [score] = await tx.select({ id: candidateScores.id, value: candidateScores.valueNum }).from(candidateScores)
    .where(and(eq(candidateScores.candidateId, candidateId), eq(candidateScores.kind, kind), eq(candidateScores.isCurrent, true)))
  const iv = await interviewOf(tx, candidateId)
  return {
    person,
    consentWithdrawn: await consentWithdrawn(tx, candidateId),
    humanChecked: iv.humanChecked,
    aiConfidence: iv.confidence,
    score: score ? { id: score.id, value: score.value === null ? null : Number(score.value) } : null,
  }
}

function blockOf(rule: AutoSendRule, r: Row, latest: number, f: Facts): AutoSendBlock | null {
  return autoSendBlock({
    rule,
    state: r.state as CandidateSummaryState,
    isLatest: r.version === latest,
    cancelled: !!r.autoSendCancelledAt,
    kind: (f.person?.kind === 'employee' || f.person?.anonymizedAt) ? 'employee' : 'candidate',
    rejected: f.person?.candidateState === 'rejected',
    consentWithdrawn: f.consentWithdrawn,
    humanChecked: f.humanChecked,
    aiConfidence: f.aiConfidence,
    scoreValue: f.score?.value ?? null,
    hasEmail: !!f.person?.email,
  })
}

export interface AutoSendReport { built: number, scheduled: number, sent: number, skipped: { id: string, reason: string }[] }

/**
 * Круг `summary.auto_send` (каждые 10 минут, `30` §11) для одного тенанта:
 *  1. **срок наступил** — `ready` с `auto_send_due_at ≤ now`: проверки §7.15 ещё раз (за задержку
 *     кандидата могли отклонить, он мог отозвать согласие, рекрутер — перепроверить оценки);
 *     прошли — отправка письмом, нет — срок снимается, причина в журнале;
 *  2. **назначение** — у кандидата оценка выбранного вида достигла порога, и Підсумок ему ещё не
 *     уходил, не назначен и не отменён ни в одной версии (авто-отправка — однократная: новую версию
 *     после отправленной отправляет человек): последняя версия `ready` получает
 *     `auto_send_due_at = now + задержка` и рекрутеру —
 *     `summary_auto_send_scheduled` «буде надіслано {час}. Можна скасувати». Документа нет вовсе —
 *     он собирается (`summary.build`), срок назначит следующий круг: задержка отсчитывается от
 *     момента, когда рекрутер может увидеть документ.
 */
export async function summaryAutoSendScan(tenantId: string, now: Date = new Date()): Promise<AutoSendReport> {
  const report: AutoSendReport = { built: 0, scheduled: 0, sent: 0, skipped: [] }
  const rule = await withTenant(tenantId, null, async tx => (await readSettings(tx, tenantId)).recruiting.summaryAutoSend) as AutoSendRule

  // 1. Срок наступил
  const due = await withTenant(tenantId, null, tx => tx.select({ id: candidateSummaries.id }).from(candidateSummaries)
    .where(and(eq(candidateSummaries.state, 'ready'), sql`${candidateSummaries.autoSendDueAt} <= ${now.toISOString()}::timestamptz`)).limit(200))
  for (const { id } of due) {
    await withTenant(tenantId, null, async (tx) => {
      const [r] = await tx.select().from(candidateSummaries).where(eq(candidateSummaries.id, id)).for('update')
      if (!r || r.state !== 'ready' || !r.autoSendDueAt || r.autoSendDueAt > now) return
      const scheduledKind = ((r.autoSendRule as { scoreKind?: CandidateScoreKind } | null)?.scoreKind) ?? rule.scoreKind
      const f = await factsOf(tx, r.candidateId, scheduledKind)
      const block = blockOf({ ...rule, scoreKind: scheduledKind }, r, await latestVersionOf(tx, r.candidateId), f)
      if (block) {
        await tx.update(candidateSummaries).set({ autoSendDueAt: null, updatedAt: new Date() }).where(eq(candidateSummaries.id, r.id))
        await recordAudit(tx, { tenantId, actorId: SYSTEM_ACTOR, action: 'summary.auto_send_skipped', entity: 'candidate_summary', entityId: r.id, after: { reason: block } })
        report.skipped.push({ id: r.id, reason: block })
        return
      }
      const sent = await sendTx(tx, tenantId, SYSTEM_ACTOR, r, 'email', 'auto')
      if (sent.ok) report.sent++
      else {
        await tx.update(candidateSummaries).set({ autoSendDueAt: null, updatedAt: new Date() }).where(eq(candidateSummaries.id, r.id))
        report.skipped.push({ id: r.id, reason: sent.code })
      }
    })
  }
  if (!rule.enabled || rule.minScore === null) return report

  // 2. Назначение: кандидаты с оценкой выбранного вида не ниже порога
  // Только действующие кандидаты (и отклонённые, если тенант их не исключил): нанятому и
  // обезличенному документ не уходит (§12 п. 8), и собирать его для них незачем
  const states = rule.skipRejected ? ['active'] : ['active', 'rejected']
  const candidates = await withTenant(tenantId, null, tx => tx.execute(sql`
    select cs.candidate_id, cs.id as score_id, cs.value_num::float8 as value
      from candidate_scores cs
      join users u on u.id = cs.candidate_id
     where cs.is_current and cs.kind = ${rule.scoreKind} and cs.value_num >= ${rule.minScore}
       and u.kind = 'candidate' and u.anonymized_at is null
       and u.candidate_state in (${sql.join(states.map(x => sql`${x}`), sql`, `)})
       and not exists (
         select 1 from candidate_summaries s
          where s.candidate_id = cs.candidate_id
            and (s.sent_at is not null or s.auto_send_due_at is not null or s.auto_send_cancelled_at is not null))
     limit 200`) as unknown as Promise<{ candidate_id: string, score_id: string, value: number }[]>)
  for (const c of candidates) {
    const outcome = await withTenant(tenantId, null, async (tx): Promise<'build' | 'scheduled' | 'skip'> => {
      const latest = await latestVersionOf(tx, c.candidate_id)
      if (!latest) return 'build'
      const [r] = await tx.select().from(candidateSummaries)
        .where(and(eq(candidateSummaries.candidateId, c.candidate_id), eq(candidateSummaries.version, latest))).for('update')
      if (!r || r.state !== 'ready' || r.autoSendDueAt || r.autoSendCancelledAt) return 'skip'
      const f = await factsOf(tx, c.candidate_id, rule.scoreKind)
      const block = blockOf(rule, r, latest, f)
      if (block) return 'skip'
      const dueAt = autoSendDueAt(now, rule.delayHours)
      await tx.update(candidateSummaries).set({
        autoSendDueAt: dueAt,
        autoSendRule: { ...rule, trigger: { scoreId: c.score_id, kind: rule.scoreKind, value: Number(c.value) }, scheduledAt: now.toISOString() },
        updatedAt: new Date(),
      }).where(eq(candidateSummaries.id, r.id))
      const [person] = await personById(tx, { fullName: users.fullName, recruiterId: users.recruiterId }, c.candidate_id) as unknown as { fullName: string, recruiterId: string | null }[]
      const recipients = person?.recruiterId ? [person.recruiterId] : await tenantAdminIds(tx, tenantId)
      for (const userId of recipients) {
        await enqueueNotification(tx, {
          tenantId, userId, code: 'summary_auto_send_scheduled', channel: 'inapp',
          payload: { name: person?.fullName ?? '', time: dueAt.toISOString() },
          dedupKey: `summary_auto_send_scheduled:${r.id}:${userId}`, refType: 'user', refId: c.candidate_id,
        })
      }
      await recordAudit(tx, { tenantId, actorId: SYSTEM_ACTOR, action: 'summary.auto_send_scheduled', entity: 'candidate_summary', entityId: r.id, after: { dueAt: dueAt.toISOString(), scoreId: c.score_id, value: Number(c.value) } })
      return 'scheduled'
    })
    if (outcome === 'scheduled') report.scheduled++
    if (outcome === 'build') {
      const built = await buildSummaryFor(tenantId, SYSTEM_ACTOR, c.candidate_id, { reason: 'auto_send' })
      if (built.ok) report.built++
    }
  }
  return report
}

/** `summary.expire` (03:50, `30` §11): ссылка старше срока — `expired`, документ по ней не открывается. */
export async function summaryExpire(tenantId: string, now: Date = new Date()): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.update(candidateSummaries).set({ state: 'expired', updatedAt: new Date() })
      .where(and(eq(candidateSummaries.state, 'sent'), sql`${candidateSummaries.shareExpiresAt} < ${now.toISOString()}::timestamptz`))
      .returning({ id: candidateSummaries.id })
    if (rows.length) await recordAudit(tx, { tenantId, actorId: SYSTEM_ACTOR, action: 'summary.expire', entity: 'candidate_summary', entityId: rows.length === 1 ? rows[0]!.id : null, after: { ids: rows.map(r => r.id) } })
    return rows.length
  })
}

/** Сборка по событию (`summary.build`): собеседование завершено, а у кандидата ещё нет Підсумку. */
export async function buildOnInterviewDone(tenantId: string, candidateId: string): Promise<'built' | 'exists' | 'skipped'> {
  const exists = await withTenant(tenantId, null, async tx => (await latestVersionOf(tx, candidateId)) > 0)
  if (exists) return 'exists'
  const r = await buildSummaryFor(tenantId, SYSTEM_ACTOR, candidateId, { reason: 'interview_done' })
  return r.ok ? 'built' : 'skipped'
}

export async function enqueueSummaryBuild(tenantId: string, candidateId: string): Promise<void> {
  await enqueueForTenant('summary.build', tenantId, { candidateId }, { singletonKey: `summary.build:${candidateId}` })
    .catch(err => console.error('[summary.build] enqueue', err))
}

// ── Стирание (`30` §7.6, §7.9, §12 п. 4) ────────────────────────────────────────────────

/**
 * Отзыв согласия и обезличивание: тело Підсумку (цитаты, обоснования, ФИО) стирается, ссылка
 * отзывается, запланированная отправка снимается — в транзакции вызывающего (`interview/redaction.ts`).
 * Строка остаётся: версия и журнал отправок нужны разбору, а не человеку.
 */
export async function redactSummariesTx(tx: TenantTx, tenantId: string, candidateId: string, reason: string): Promise<number> {
  const rows = await tx.execute(sql`
    update candidate_summaries
       set body = '{}'::jsonb, redacted_at = now(), auto_send_due_at = null, updated_at = now(),
           revoked_at = case when state in ('draft', 'ready', 'sent') then now() else revoked_at end,
           revoke_reason = case when state in ('draft', 'ready', 'sent') then ${reason} else revoke_reason end,
           state = case when state in ('draft', 'ready', 'sent') then 'revoked' else state end
     where candidate_id = ${candidateId}::uuid and redacted_at is null
    returning id`) as unknown as { id: string }[]
  if (rows.length) await recordAudit(tx, { tenantId, actorId: null, action: 'summary.redacted', entity: 'user', entityId: candidateId, after: { reason, summaries: rows.map(r => r.id) } })
  return rows.length
}

// ── Публичная ссылка (`30` §10, `41` §8.3.2, решение `44` В-9) ──────────────────────────

export interface PublicCtx { ip: string, userAgent?: string | null }

export type PublicSummaryResult
  = | { ok: true, summary: { version: number, completeness: 'full' | 'partial', lang: Locale, sentAt: string, expiresAt: string, document: ReturnType<typeof candidateView>, disclaimerLine: string } }
    | { ok: false, code: 'not_found' | 'expired' | 'revoked' | 'rate_limited' }

const TOKEN_RE = /^[\w-]{16,64}$/

/** Просмотров документа с одного адреса за 10 минут — потолок, как у публичной вакансии (`29` §7.4). */
export const SUMMARY_PUBLIC_VIEWS_PER_10MIN = 30

/**
 * Документ кандидату по ссылке, без входа. Единственное обращение к БД мимо `withTenant()` — вызов
 * функции `SECURITY DEFINER` `candidate_summary_public_lookup`: она отдаёт идентификатор и тенанта,
 * ни одного поля документа; дальше — `withTenant()` тенанта из токена. Ответ — только включённые
 * секции, без ПД третьих лиц, и всегда строка «Документ сформовано автоматично».
 */
export async function publicSummary(token: string, ctx: PublicCtx): Promise<PublicSummaryResult> {
  if (!TOKEN_RE.test(token ?? '')) {
    await alignDelay()
    return { ok: false, code: 'not_found' }
  }
  const [link] = await db.execute(sql`select * from candidate_summary_public_lookup(${token})`) as unknown as { id: string, tenant_id: string }[]
  if (!link) {
    await alignDelay()
    return { ok: false, code: 'not_found' }
  }
  if (!await hitRateLimit(`summary:view:${link.tenant_id}:${ipHash(link.tenant_id, ctx.ip)}`, SUMMARY_PUBLIC_VIEWS_PER_10MIN, 600)) return { ok: false, code: 'rate_limited' }
  return withTenant(link.tenant_id, null, async (tx): Promise<PublicSummaryResult> => {
    const [r] = await tx.select().from(candidateSummaries).where(eq(candidateSummaries.id, link.id))
    if (!r) return { ok: false, code: 'not_found' }
    if (r.state === 'revoked' || r.redactedAt) return { ok: false, code: 'revoked' }
    if (r.state === 'expired' || (r.shareExpiresAt && r.shareExpiresAt <= new Date())) return { ok: false, code: 'expired' }
    if (r.state !== 'sent') return { ok: false, code: 'not_found' }
    const body = r.body as SummaryBody
    return {
      ok: true,
      summary: {
        version: r.version,
        completeness: r.completeness as 'full' | 'partial',
        lang: resolveLocale(r.lang),
        sentAt: r.sentAt!.toISOString(),
        expiresAt: r.shareExpiresAt!.toISOString(),
        document: candidateView(body, r.sections as string[]),
        disclaimerLine: disclaimerLine(body.disclaimer),
      },
    }
  })
}
