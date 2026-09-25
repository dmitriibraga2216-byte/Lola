import { and, desc, eq, sql } from 'drizzle-orm'
import { surveyParticipations, surveyResponses, surveys, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import type { PollAnswer, PollInput, PollPatch, PollQuestion } from '../../shared/schemas/assessment'
import { POLL_MUTABLE_WHEN_LOCKED } from '../../shared/schemas/assessment'
import { loadScale } from './assessment'
import type { ScaleInfo } from './assessment'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'

/**
 * Опросы (docs/03 §3.8; docs/20 §14.5, §14.7 — Spec 20).
 * Четыре типа вопроса, «свій варіант», «по шкалі» (scales kind=levels), режим «з умовами» — следующий вопрос
 * выбирает сервер по правилам `next`, клиент граф не видит. «Конфіденційно» — ответы с именами видит только
 * владелец; «Анонімне» — автор не хранится: ответ без `user_id`, черновик живёт в `survey_participations`
 * и стирается при отправке. Порог показа анонимной сводки — 5 ответов (docs/03 §3.8).
 */

interface Ctx { tenantId: string, actorId: string }

export type SurveyQuestion = PollQuestion

const ANON_THRESHOLD = 5

export async function listSurveys(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: surveys.id, title: surveys.title, kind: surveys.kind, status: surveys.status, mode: surveys.mode, isAnonymous: surveys.isAnonymous, isConfidential: surveys.isConfidential,
      showResults: surveys.showResults, isLocked: surveys.isLocked, tags: surveys.tags, opensAt: surveys.opensAt, closesAt: surveys.closesAt, triggerCourseId: surveys.triggerCourseId,
      createdAt: surveys.createdAt, updatedAt: surveys.updatedAt, createdBy: surveys.createdBy,
      questions: sql<number>`jsonb_array_length(${surveys.questions})`,
      responses: sql<number>`(select count(*)::int from ${surveyResponses} r where r.survey_id = ${surveys.id})`,
    }).from(surveys).orderBy(desc(surveys.updatedAt))
  })
}

export async function getSurvey(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select().from(surveys).where(eq(surveys.id, id))
    return s ?? null
  })
}

export async function createSurvey(ctx: Ctx, input: PollInput) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.insert(surveys).values({
      tenantId: ctx.tenantId,
      title: input.title, description: input.description ?? null, kind: input.kind, mode: input.mode, questions: input.questions,
      isAnonymous: input.isAnonymous, isConfidential: input.isConfidential, showResults: input.showResults, tags: input.tags,
      opensAt: input.opensAt ? new Date(input.opensAt) : null, closesAt: input.closesAt ? new Date(input.closesAt) : null,
      triggerCourseId: input.triggerCourseId ?? null, createdBy: ctx.actorId,
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'survey.create', entity: 'survey', entityId: s!.id, after: { title: input.title, mode: input.mode, isAnonymous: input.isAnonymous, isConfidential: input.isConfidential } })
    return s!
  })
}

export type SurveySaveResult = { ok: true, survey: typeof surveys.$inferSelect } | { ok: false, code: 'not_found' | 'locked', fields?: string[] }

/** После первого ответа (docs/20 §14.4) меняются только карточка и сроки: вопросы, режим, анонимность и конфиденциальность заморожены. */
export async function updateSurvey(ctx: Ctx, id: string, input: PollPatch): Promise<SurveySaveResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(surveys).where(eq(surveys.id, id))
    if (!before) return { ok: false as const, code: 'not_found' as const }
    if (before.isLocked) {
      const frozen: string[] = []
      for (const k of Object.keys(input) as (keyof PollPatch)[]) {
        if (input[k] === undefined || (POLL_MUTABLE_WHEN_LOCKED as readonly string[]).includes(k)) continue
        const was = k === 'questions' ? JSON.stringify(before.questions) : k === 'tags' ? JSON.stringify(before.tags) : before[k as keyof typeof before]
        const now = k === 'questions' || k === 'tags' ? JSON.stringify(input[k]) : input[k]
        if (was !== now) frozen.push(k)
      }
      if (frozen.length) return { ok: false as const, code: 'locked' as const, fields: frozen }
    }
    const [s] = await tx.update(surveys).set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.questions !== undefined ? { questions: input.questions } : {}),
      ...(input.isAnonymous !== undefined ? { isAnonymous: input.isAnonymous } : {}),
      ...(input.isConfidential !== undefined ? { isConfidential: input.isConfidential } : {}),
      ...(input.showResults !== undefined ? { showResults: input.showResults } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.opensAt !== undefined ? { opensAt: input.opensAt ? new Date(input.opensAt) : null } : {}),
      ...(input.closesAt !== undefined ? { closesAt: input.closesAt ? new Date(input.closesAt) : null } : {}),
      ...(input.triggerCourseId !== undefined ? { triggerCourseId: input.triggerCourseId } : {}),
      updatedAt: new Date(),
    }).where(eq(surveys.id, id)).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'survey.update', entity: 'survey', entityId: id, before: { title: before.title, status: before.status }, after: { title: s!.title, status: s!.status, fields: Object.keys(input) } })
    // D-019: изменился состав вопросов опроса → баннер «N завдань змінено» у назначений (docs/15 §14.6)
    if (input.questions !== undefined && JSON.stringify(before.questions) !== JSON.stringify(s!.questions)) {
      const { markContentChanged } = await import('./tasks')
      await markContentChanged(tx, 'poll', id)
    }
    return { ok: true as const, survey: s! }
  })
}

/** Опросы, доступные человеку сейчас: активные в окне, ещё не отправленные (по участию, не по ответу). */
export async function mySurveys(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: surveys.id, title: surveys.title, description: surveys.description, kind: surveys.kind, mode: surveys.mode, isAnonymous: surveys.isAnonymous, closesAt: surveys.closesAt,
      questions: sql<number>`jsonb_array_length(${surveys.questions})`,
      inProgress: sql<boolean>`exists (select 1 from ${surveyParticipations} p where p.survey_id = ${surveys.id} and p.user_id = ${ctx.actorId}::uuid and p.status = 'in_progress')`,
    })
      .from(surveys)
      .where(and(
        eq(surveys.status, 'active'),
        sql`(${surveys.opensAt} is null or ${surveys.opensAt} <= now())`,
        sql`(${surveys.closesAt} is null or ${surveys.closesAt} > now())`,
        sql`not exists (select 1 from ${surveyParticipations} p where p.survey_id = ${surveys.id} and p.user_id = ${ctx.actorId}::uuid and p.status = 'submitted')`,
      ))
      .orderBy(desc(surveys.createdAt))
  })
}

// ── Прохождение: сервер отдаёт следующий вопрос ──────────────────────────

interface Draft { answers: Record<string, PollAnswer>, path: string[] }

/** Вопрос наружу: без правил переходов (граф знает только сервер), со шкалой для «По шкалі». */
async function presentQuestion(tx: TenantTx, q: PollQuestion) {
  const { next: _next, ...rest } = q
  void _next
  const scale = q.type === 'scale' && q.scaleId ? await loadScale(tx, q.scaleId) : null
  return { ...rest, scale: scale ? { name: scale.name, options: scale.options } : null }
}

/** Следующий вопрос: «з умовами» — по правилу для выбранного варианта, иначе по умолчанию; линейный — по порядку. */
export function nextQuestionId(s: { mode: string, questions: PollQuestion[] }, current: PollQuestion | null, answer: PollAnswer | null): string | null {
  const qs = s.questions
  if (!current) return qs[0]?.id ?? null
  const idx = qs.findIndex(q => q.id === current.id)
  if (s.mode === 'conditional' && current.next?.length) {
    const chosen = answer && 'optionId' in answer ? answer.optionId : answer && 'optionIds' in answer ? answer.optionIds[0] : undefined
    const rule = (chosen ? current.next.find(n => n.optionId === chosen) : undefined) ?? current.next.find(n => !n.optionId)
    if (rule) return rule.goTo === 'end' ? null : rule.goTo
  }
  return qs[idx + 1]?.id ?? null
}

export type AnswerErrorCode = 'required' | 'bad_option' | 'own_not_allowed' | 'bad_value' | 'files_not_allowed'
export type AnswerCheck = { ok: true, answer: PollAnswer | null } | { ok: false, code: AnswerErrorCode }

/** Проверка ответа по типу вопроса (сервер считает, клиент показывает). */
export function checkAnswer(q: PollQuestion, answer: PollAnswer | null, scale: ScaleInfo | null): AnswerCheck {
  if (answer == null) return q.required === false ? { ok: true, answer: null } : { ok: false, code: 'required' }
  const optionIds = new Set((q.options ?? []).map(o => o.id))
  switch (q.type) {
    case 'single':
      if ('own' in answer && !('optionIds' in answer)) return q.allowOwnOption ? { ok: true, answer: { own: answer.own } } : { ok: false, code: 'own_not_allowed' }
      if (!('optionId' in answer)) return { ok: false, code: 'bad_option' }
      return optionIds.has(answer.optionId) ? { ok: true, answer: { optionId: answer.optionId } } : { ok: false, code: 'bad_option' }
    case 'multi': {
      if (!('optionIds' in answer)) return { ok: false, code: 'bad_option' }
      if (answer.optionIds.some(id => !optionIds.has(id))) return { ok: false, code: 'bad_option' }
      const own = answer.own?.trim()
      if (own && !q.allowOwnOption) return { ok: false, code: 'own_not_allowed' }
      if (!answer.optionIds.length && !own) return q.required === false ? { ok: true, answer: null } : { ok: false, code: 'required' }
      return { ok: true, answer: { optionIds: answer.optionIds, ...(own ? { own } : {}) } }
    }
    case 'free': {
      if (!('text' in answer)) return { ok: false, code: 'bad_value' }
      if (answer.fileIds?.length && !q.allowFiles) return { ok: false, code: 'files_not_allowed' }
      if (!answer.text.trim() && !answer.fileIds?.length) return q.required === false ? { ok: true, answer: null } : { ok: false, code: 'required' }
      return { ok: true, answer: { text: answer.text.trim(), ...(answer.fileIds?.length ? { fileIds: answer.fileIds } : {}) } }
    }
    case 'scale': {
      if (!('value' in answer)) return { ok: false, code: 'bad_value' }
      const allowed = scale ? scale.options.map(o => o.value) : [1, 2, 3, 4, 5]
      return allowed.includes(answer.value) ? { ok: true, answer: { value: answer.value } } : { ok: false, code: 'bad_value' }
    }
  }
}

export type StartResult = { ok: true, question: Awaited<ReturnType<typeof presentQuestion>> | null, index: number, total: number, isAnonymous: boolean, mode: string, title: string } | { ok: false, code: 'not_found' | 'closed' | 'already' }

/** Начать или продолжить: черновик в участии; первое участие замораживает опрос (docs/20 §14.4). */
export async function startSurvey(ctx: Ctx, surveyId: string, enrollmentId?: string): Promise<StartResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select().from(surveys).where(eq(surveys.id, surveyId))
    if (!s) return { ok: false as const, code: 'not_found' as const }
    if (s.status !== 'active' || (s.closesAt && s.closesAt < new Date()) || (s.opensAt && s.opensAt > new Date())) return { ok: false as const, code: 'closed' as const }
    const [p] = await tx.insert(surveyParticipations).values({ tenantId: ctx.tenantId, surveyId, userId: ctx.actorId, draft: { answers: {}, path: [] }, enrollmentId: enrollmentId ?? null })
      .onConflictDoNothing().returning()
    const part = p ?? (await tx.select().from(surveyParticipations).where(and(eq(surveyParticipations.surveyId, surveyId), eq(surveyParticipations.userId, ctx.actorId))))[0]!
    if (part.status === 'submitted') return { ok: false as const, code: 'already' as const }
    if (!s.isLocked) {
      await tx.update(surveys).set({ isLocked: true, updatedAt: new Date() }).where(eq(surveys.id, surveyId))
      await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'survey.lock', entity: 'survey', entityId: surveyId, after: { isLocked: true } })
    }
    const qs = s.questions as PollQuestion[]
    const draft = part.draft as Draft
    // Продолжаем с последнего показанного вопроса без ответа, иначе — следующий за последним отвеченным
    const lastId = draft.path[draft.path.length - 1]
    const last = lastId ? qs.find(q => q.id === lastId) ?? null : null
    const currentId = last && !(last.id in draft.answers) ? last.id : nextQuestionId(s as { mode: string, questions: PollQuestion[] }, last, last ? draft.answers[last.id] ?? null : null)
    const current = currentId ? qs.find(q => q.id === currentId) ?? null : null
    if (current && !draft.path.includes(current.id)) {
      draft.path.push(current.id)
      await tx.update(surveyParticipations).set({ draft, updatedAt: new Date() }).where(eq(surveyParticipations.id, part.id))
    }
    return { ok: true as const, question: current ? await presentQuestion(tx, current) : null, index: draft.path.length, total: qs.length, isAnonymous: s.isAnonymous, mode: s.mode, title: s.title }
  })
}

export type AnswerResult =
  | { ok: true, done: false, question: Awaited<ReturnType<typeof presentQuestion>>, index: number, total: number }
  | { ok: true, done: true, results: Awaited<ReturnType<typeof reportTx>> | null }
  | { ok: false, code: 'not_found' | 'closed' | 'already' | 'wrong_question' | AnswerErrorCode }

/** Ответ на текущий вопрос → следующий по правилам; последний — фиксация ответа без автора у анонимного опроса. */
export async function answerQuestion(ctx: Ctx, surveyId: string, questionId: string, answer: PollAnswer | null): Promise<AnswerResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select().from(surveys).where(eq(surveys.id, surveyId))
    if (!s) return { ok: false as const, code: 'not_found' as const }
    if (s.status !== 'active' || (s.closesAt && s.closesAt < new Date())) return { ok: false as const, code: 'closed' as const }
    const [part] = await tx.select().from(surveyParticipations).where(and(eq(surveyParticipations.surveyId, surveyId), eq(surveyParticipations.userId, ctx.actorId)))
    if (!part) return { ok: false as const, code: 'not_found' as const }
    if (part.status === 'submitted') return { ok: false as const, code: 'already' as const }
    const qs = s.questions as PollQuestion[]
    const draft = part.draft as Draft
    const current = qs.find(q => q.id === questionId)
    if (!current || draft.path[draft.path.length - 1] !== questionId) return { ok: false as const, code: 'wrong_question' as const }
    const scale = current.type === 'scale' && current.scaleId ? await loadScale(tx, current.scaleId) : null
    const check = checkAnswer(current, answer, scale)
    if (!check.ok) return check
    if (check.answer != null) draft.answers[current.id] = check.answer
    else draft.answers = Object.fromEntries(Object.entries(draft.answers).filter(([k]) => k !== current.id))
    const nextId = nextQuestionId(s as { mode: string, questions: PollQuestion[] }, current, check.answer)
    const next = nextId ? qs.find(q => q.id === nextId) ?? null : null
    if (next) {
      draft.path.push(next.id)
      await tx.update(surveyParticipations).set({ draft, updatedAt: new Date() }).where(eq(surveyParticipations.id, part.id))
      return { ok: true as const, done: false as const, question: await presentQuestion(tx, next), index: draft.path.length, total: qs.length }
    }
    // Финал: ответ отдельно от участия; у анонимного опроса — без user_id, черновик стирается
    await tx.insert(surveyResponses).values({ tenantId: ctx.tenantId, surveyId, userId: s.isAnonymous ? null : ctx.actorId, enrollmentId: part.enrollmentId, answers: draft.answers, path: draft.path })
    await tx.update(surveyParticipations).set({ status: 'submitted', draft: {}, submittedAt: new Date(), updatedAt: new Date() }).where(eq(surveyParticipations.id, part.id))
    // docs/33 D-020: опитування пройдено — єдиний хук (участь іменна навіть в анонімному опитуванні, відповідь — ні)
    const { onTaskCompleted } = await import('./taskCompletion')
    await onTaskCompleted(tx, ctx.tenantId, ctx.actorId, { contentType: 'poll', contentId: surveyId, status: 'done', enrollmentId: part.enrollmentId, sourceKind: 'survey_response', sourceId: part.id })
    const results = s.showResults ? await reportTx(tx, s, { withRespondents: false }) : null
    return { ok: true as const, done: true as const, results }
  }).then(async (res) => {
    // Узел траектории «Завдання» с опитуванням: тот же хук результата, что у курса и теста, — после
    // фиксации ответа (раньше опитування писало только журнал, и узел не засчитывался никогда)
    if (res.ok && res.done) {
      await import('./trajectories').then(t => t.onTaskResult(ctx.tenantId, ctx.actorId, 'poll', surveyId, { passed: true }))
        .catch(err => console.error('trajectory poll hook', err))
    }
    return res
  })
}

// ── Сводка ──────────────────────────────────────────────────────────────

const answerText = (q: PollQuestion, a: PollAnswer | undefined): string[] => {
  if (!a) return []
  const label = (id: string) => q.options?.find(o => o.id === id)?.text ?? id
  if ('optionId' in a) return [label(a.optionId)]
  if ('optionIds' in a) return [...a.optionIds.map(label), ...(a.own ? [a.own] : [])]
  if ('own' in a) return [a.own]
  if ('text' in a) return a.text ? [a.text] : []
  if ('value' in a) return [String(a.value)]
  return []
}

async function reportTx(tx: TenantTx, s: typeof surveys.$inferSelect, opts: { withRespondents: boolean }) {
  const rows = await tx.select({ id: surveyResponses.id, answers: surveyResponses.answers, userId: surveyResponses.userId, submittedAt: surveyResponses.submittedAt }).from(surveyResponses).where(eq(surveyResponses.surveyId, s.id))
  const total = rows.length
  if (s.isAnonymous && total < ANON_THRESHOLD) {
    return { id: s.id, title: s.title, total, hidden: true as const, threshold: ANON_THRESHOLD, isAnonymous: s.isAnonymous, isConfidential: s.isConfidential, questions: [], respondents: null }
  }
  const qs = s.questions as PollQuestion[]
  const questions = []
  for (const q of qs) {
    const answers = rows.map(r => (r.answers as Record<string, PollAnswer>)[q.id]).filter((a): a is PollAnswer => a != null)
    if (q.type === 'scale') {
      const scale = q.scaleId ? await loadScale(tx, q.scaleId) : null
      const nums = answers.map(a => ('value' in a ? a.value : Number.NaN)).filter(n => !Number.isNaN(n))
      const dist: Record<string, number> = {}
      for (const n of nums) { const key = scale?.options.find(o => o.value === n)?.label ?? String(n); dist[key] = (dist[key] ?? 0) + 1 }
      questions.push({ id: q.id, text: q.text, type: q.type, answered: nums.length, avg: nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length * 100) / 100 : null, distribution: dist, scale: scale?.name ?? null })
      continue
    }
    if (q.type === 'single' || q.type === 'multi') {
      const dist: Record<string, number> = {}
      for (const o of q.options ?? []) dist[o.text] = 0
      const own: string[] = []
      for (const a of answers) {
        if ('optionId' in a) dist[q.options?.find(o => o.id === a.optionId)?.text ?? a.optionId] = (dist[q.options?.find(o => o.id === a.optionId)?.text ?? a.optionId] ?? 0) + 1
        else if ('optionIds' in a) { for (const id of a.optionIds) { const k = q.options?.find(o => o.id === id)?.text ?? id; dist[k] = (dist[k] ?? 0) + 1 } if (a.own) own.push(a.own) }
        else if ('own' in a) own.push(a.own)
      }
      questions.push({ id: q.id, text: q.text, type: q.type, answered: answers.length, distribution: dist, own })
      continue
    }
    questions.push({ id: q.id, text: q.text, type: q.type, answered: answers.length, texts: answers.flatMap(a => answerText(q, a)) })
  }
  // Индивидуальные ответы: только не для анонимного; имена — только вне «конфіденційно» либо владельцу (решает вызывающий)
  let respondents: { id: string, name: string | null, submittedAt: Date, answers: Record<string, string[]> }[] | null = null
  if (opts.withRespondents && !s.isAnonymous) {
    const ids = [...new Set(rows.map(r => r.userId).filter((x): x is string => !!x))]
    const names = new Map(ids.length ? (await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(sql`${users.id} in ${ids}`)).map(u => [u.id, u.fullName]) : [])
    respondents = rows.map(r => ({ id: r.id, name: r.userId ? names.get(r.userId) ?? null : null, submittedAt: r.submittedAt, answers: Object.fromEntries(qs.map(q => [q.id, answerText(q, (r.answers as Record<string, PollAnswer>)[q.id])])) }))
  }
  return { id: s.id, title: s.title, total, hidden: false as const, isAnonymous: s.isAnonymous, isConfidential: s.isConfidential, questions, respondents }
}

/**
 * Сводка (docs/20 §14.5): распределения, средние; анонимные — порог 5 ответов.
 * «Конфіденційно»: индивидуальные ответы с именами — только владельцу опроса; остальные видят сводку и ответы без имён.
 */
export async function surveyReport(ctx: Ctx, surveyId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select().from(surveys).where(eq(surveys.id, surveyId))
    if (!s) return null
    const isOwner = s.createdBy === ctx.actorId
    const r = await reportTx(tx, s, { withRespondents: true })
    if (s.isConfidential && !isOwner && r.respondents) r.respondents = r.respondents.map(x => ({ ...x, name: null }))
    return { ...r, isOwner }
  })
}

/** Автозапуск после курса (docs/03 §3.8): опрос kind=course_feedback с trigger_course_id. */
export async function triggerCourseFeedback(tenantId: string, userId: string, courseId: string, enrollmentId: string) {
  await withTenant(tenantId, userId, async (tx) => {
    const list = await tx.select({ id: surveys.id, title: surveys.title }).from(surveys)
      .where(and(eq(surveys.status, 'active'), eq(surveys.kind, 'course_feedback'), eq(surveys.triggerCourseId, courseId)))
    for (const s of list) {
      await enqueueNotification(tx, { tenantId, userId, code: 'survey_invite', payload: { survey: s.title, surveyId: s.id, enrollmentId }, dedupKey: `survey:${s.id}:${enrollmentId}` })
    }
  })
}
