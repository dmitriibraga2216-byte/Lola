import { and, asc, eq } from 'drizzle-orm'
import { interviewCriteria, interviewScenarios, questions, quizQuestions, quizzes } from '../../db/schema'
import { withTenant } from '../../utils/withTenant'
import type { LimitCheck } from '../tenantLimits'
import { recordAudit } from '../audit'
import { callModel } from '../ai/gateway'
import type { AiUnavailableReason } from '../ai/policy'
import { INTERVIEW_CRITERIA_PROMPT } from '../ai/prompts'
import type { InterviewCriteriaInput, InterviewCriterionDraft } from '../ai/prompts'
import { promptTextOf } from './common'

/**
 * «Згенерувати критерії (ШІ)» сценария собеседования (`docs/v2/30` §6.2, §10; решение владельца
 * 01.10 — `44` Р-AI2.10).
 *
 * **Черновик, а не запись.** Модель предлагает — человек правит и сохраняет каждый критерий сам
 * («Перевірте та збережіть: критерії створено програмою», §6.2; инвариант 18). Ответ ручки —
 * список предложений; строка `interview_criteria` с `source = 'ai_suggested'` появляется только
 * из `POST /interview-scenarios/:id/criteria` по «Зберегти» (`scenarios.ts#addCriterion`).
 *
 * **Модель — через шлюз** (`ai/gateway.ts`): роль `generate`, строка `ai_calls` с
 * `ref_kind = 'interview_scenario'` и `ref_id` — сценарий, ось `ai_generate_ops`: одна генерация —
 * одна операция, списанная в одной транзакции с записью журнала. Отказ по лимиту, истёкший ИИ
 * и упавший провайдер не списывают ничего.
 *
 * Вход модели — название сценария и теста, тексты вопросов и названия уже заведённых критериев.
 * Ответов кандидатов и их ПД здесь нет: критерии описывают роль, а не людей.
 */

interface Ctx { tenantId: string, actorId: string }

export type GenerateScenarioCriteriaResult
  = | { ok: true, criteria: InterviewCriterionDraft[], aiCallId: number }
    | { ok: false, code: 'not_found' | 'published' | 'archived' }
    | { ok: false, code: 'limit_exceeded', check: LimitCheck }
    | { ok: false, code: 'ai_unavailable', reason: AiUnavailableReason }
    /** `reason`: `no_provider` — у роли нет активного профиля, иначе последний код отказа провайдера. */
    | { ok: false, code: 'provider_failed', reason: string }

export async function generateScenarioCriteria(ctx: Ctx, scenarioId: string, count: number): Promise<GenerateScenarioCriteriaResult> {
  const loaded = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.select().from(interviewScenarios).where(eq(interviewScenarios.id, scenarioId))
    if (!row) return { ok: false as const, code: 'not_found' as const }
    // Критерии меняются только у черновика (как ручное добавление): предлагать нечего сохранить
    if (row.status === 'published') return { ok: false as const, code: 'published' as const }
    if (row.status === 'archived') return { ok: false as const, code: 'archived' as const }
    const [quiz] = await tx.select({ title: quizzes.title }).from(quizzes).where(eq(quizzes.id, row.quizId))
    const qs = await tx.select({ stem: questions.stem }).from(quizQuestions)
      .innerJoin(questions, eq(questions.id, quizQuestions.questionId))
      .where(and(eq(quizQuestions.quizId, row.quizId), eq(questions.status, 'active')))
      .orderBy(asc(quizQuestions.sort))
    const existing = await tx.select({ name: interviewCriteria.nameUk }).from(interviewCriteria)
      .where(eq(interviewCriteria.scenarioId, scenarioId))
    return { ok: true as const, row, quizTitle: quiz?.title ?? null, questions: qs.map(q => promptTextOf(q.stem).slice(0, 500)).filter(Boolean), existing: existing.map(e => e.name) }
  })
  if (!loaded.ok) return loaded

  const input: InterviewCriteriaInput = {
    scenarioName: loaded.row.name,
    quizTitle: loaded.quizTitle,
    questions: loaded.questions,
    existing: loaded.existing,
    count,
    language: (['uk', 'en', 'ru'].includes(loaded.row.transcribeLang) ? loaded.row.transcribeLang : 'uk') as InterviewCriteriaInput['language'],
  }

  const r = await callModel({ tenantId: ctx.tenantId, actorId: ctx.actorId }, INTERVIEW_CRITERIA_PROMPT, input, {
    ref: { kind: 'interview_scenario', id: scenarioId },
    async persist(tx, generated, call) {
      await recordAudit(tx, {
        tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'interview.criteria.ai_generated', entity: 'interview_scenario', entityId: scenarioId,
        after: { count: generated.criteria.length, aiCallId: call.callId, model: call.model.modelName },
      })
    },
  })
  if (r.ok) return { ok: true, criteria: r.output.criteria, aiCallId: r.callId }
  if (r.code === 'limit_exceeded' && r.check) return { ok: false, code: 'limit_exceeded', check: r.check }
  if (r.code === 'ai_unavailable' && r.reason) return { ok: false, code: 'ai_unavailable', reason: r.reason }
  return { ok: false, code: 'provider_failed', reason: r.code === 'provider_failed' ? r.providerError ?? r.code : r.code }
}
