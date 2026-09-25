import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { vacancies, vacancyAiGenerations } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { LimitCheck } from './tenantLimits'
import { recordAudit } from './audit'
import { rowById, cardOf } from './vacancies'
import type { Viewer, VacancyCard } from './vacancies'
import type { VacancyAiTextRequestInput } from '../../shared/schemas/vacancies'
import { callModel, type CallResult } from './ai/gateway'
import type { AiUnavailableReason } from './ai/policy'
import { VACANCY_CRITERIA_PROMPT, VACANCY_TEXT_PROMPT } from './ai/prompts'
import type { VacancyCriteriaInput, VacancyCriterionDraft, VacancyTextInput } from './ai/prompts'

/**
 * Генерация текста вакансии и черновика критериев (`docs/v2/29-vacancies.md` §7.10–§7.11,
 * §3.6, §3.10, план `45` PR-17).
 *
 * **ИИ не принимает решений о людях** (инвариант 18, `docs/v2/28` §7.4): здесь генерируется
 * только текст вакансии и черновик критериев для человека — ни одна строка `vacancy_criteria`
 * не появляется без явного «Зберегти критерії» (§7.11), ни один кандидат не оценивается.
 *
 * **Модель — через шлюз** (`server/services/ai/gateway.ts`, PR-27): профиль роли `generate`,
 * строка `ai_calls` на каждый вызов (`ref_kind = 'vacancy_generation'`, `ref_id` — строка
 * `vacancy_ai_generations`), ось `ai_generate_ops`. Одна генерация = 1 операция, списывается
 * **в той же транзакции**, что и текст блока и строка журнала генераций (§7.10): упавший вызов,
 * отказ по лимиту и несохранённый результат не списывают ничего. По умолчанию профиль — заглушка
 * PR-17 (`HANDOFF` §6); тексты заглушки и промптов — `ai/prompts.ts`.
 */

/** Отказ генерации: вакансии нет, ось исчерпана, ИИ-подписка не действует или провайдер не ответил. */
export type GenerateFailure
  = | { ok: false, code: 'not_found' }
    | { ok: false, code: 'limit_exceeded', check: LimitCheck }
    | { ok: false, code: 'ai_unavailable', reason: AiUnavailableReason }
    /** `reason`: `no_provider` — у роли нет активного профиля, иначе последний код отказа провайдера. */
    | { ok: false, code: 'provider_failed', reason: string }

export type GenerateTextResult = { ok: true, html: string, generationId: string } | GenerateFailure
export type GenerateCriteriaResult = { ok: true, criteria: VacancyCriterionDraft[], generationId: string } | GenerateFailure

/**
 * Отказ шлюза → строка журнала генераций без списания (§3.10: `limited` — лимит или подписка,
 * `failed` — провайдер) и ответ вызывающему.
 */
async function recordFailure(v: Viewer, vacancyId: string, generationId: string, target: VacancyAiTextRequestInput['target'] | 'criteria', input: Record<string, unknown>, r: Extract<CallResult<unknown>, { ok: false }>): Promise<GenerateFailure> {
  const limited = r.code === 'limit_exceeded' || r.code === 'ai_unavailable'
  await withTenant(v.tenantId, v.actorId, tx => tx.insert(vacancyAiGenerations).values({
    id: generationId, tenantId: v.tenantId, vacancyId, target, input, opsCharged: 0,
    status: limited ? 'limited' : 'failed', errorCode: r.code === 'provider_failed' ? r.providerError ?? r.code : r.code, authorId: v.actorId,
  }))
  if (r.code === 'limit_exceeded' && r.check) return { ok: false, code: 'limit_exceeded', check: r.check }
  if (r.code === 'ai_unavailable' && r.reason) return { ok: false, code: 'ai_unavailable', reason: r.reason }
  return { ok: false, code: 'provider_failed', reason: r.code === 'provider_failed' ? r.providerError ?? r.code : r.code }
}

/**
 * `POST /vacancies/:id/ai-text` (§7.10, критерии §13 к. 9, 10). Вход модели — только то, что
 * §7.10 разрешает: без вилки, контактов, названия курса и критериев оценки. Повтор того же
 * блока — новая операция (новая строка генерации — новый ключ идемпотентности).
 */
export async function generateVacancyText(v: Viewer, vacancyId: string, input: VacancyAiTextRequestInput): Promise<GenerateTextResult> {
  const vac = await withTenant(v.tenantId, v.actorId, tx => rowById(tx, v, vacancyId))
  if (!vac) return { ok: false, code: 'not_found' }

  const full = await withTenant(v.tenantId, v.actorId, async (tx) => {
    const [row] = await tx.select({
      descriptionHtml: vacancies.descriptionHtml, requirementsHtml: vacancies.requirementsHtml,
      dutiesHtml: vacancies.dutiesHtml, extraHtml: vacancies.extraHtml, aiBlocks: vacancies.aiBlocks,
      publicLanguage: vacancies.publicLanguage,
    }).from(vacancies).where(eq(vacancies.id, vacancyId))
    return row
  })

  const aiInput: VacancyTextInput = {
    target: input.target,
    tone: input.tone ?? null,
    title: vac.title,
    city: vac.city,
    employmentType: vac.employmentType,
    workFormat: vac.workFormat,
    experienceLevel: vac.experienceLevel,
    educationLevel: vac.educationLevel,
    siblingBlocks: {
      description: full?.descriptionHtml ?? null, requirements: full?.requirementsHtml ?? null,
      duties: full?.dutiesHtml ?? null, extra: full?.extraHtml ?? null,
    },
    language: (full?.publicLanguage as VacancyTextInput['language']) ?? 'uk',
  }
  const generationId = randomUUID()
  const journalInput = { target: input.target, tone: input.tone ?? null, siblingBlocks: Object.keys(aiInput.siblingBlocks).filter(k => aiInput.siblingBlocks[k]) }

  const r = await callModel({ tenantId: v.tenantId, actorId: v.actorId }, VACANCY_TEXT_PROMPT, aiInput, {
    ref: { kind: 'vacancy_generation', id: generationId },
    async persist(tx, generated, call) {
      const column = `${input.target}Html` as 'descriptionHtml' | 'requirementsHtml' | 'dutiesHtml' | 'extraHtml'
      const aiBlocks = { ...(full?.aiBlocks as Record<string, unknown> ?? {}) }
      aiBlocks[input.target] = {
        generatedAt: new Date().toISOString(), generatedBy: v.actorId, model: call.model.modelName,
        promptHash: null, editedAt: null, charsAtGeneration: generated.html.length, acknowledged: false,
      }
      await tx.update(vacancies).set({ [column]: generated.html, aiBlocks, updatedAt: new Date() } as Partial<typeof vacancies.$inferInsert>)
        .where(eq(vacancies.id, vacancyId))
      await tx.insert(vacancyAiGenerations).values({
        id: generationId, tenantId: v.tenantId, vacancyId, target: input.target, input: journalInput,
        outputChars: generated.html.length, model: call.model.modelName, opsCharged: 1, status: 'ok', authorId: v.actorId,
      })
      await recordAudit(tx, {
        tenantId: v.tenantId, actorId: v.actorId, action: 'vacancy.ai_text_generated', entity: 'vacancy', entityId: vacancyId,
        after: { target: input.target, generationId, chars: generated.html.length, aiCallId: call.callId },
      })
    },
  })
  if (!r.ok) return recordFailure(v, vacancyId, generationId, input.target, journalInput, r)
  return { ok: true, html: r.output.html, generationId }
}

/** `POST /vacancies/:id/criteria/generate` (§7.11): черновик, ничего не сохраняется без «Зберегти критерії». */
export async function generateVacancyCriteria(v: Viewer, vacancyId: string): Promise<GenerateCriteriaResult> {
  const vac = await withTenant(v.tenantId, v.actorId, tx => rowById(tx, v, vacancyId))
  if (!vac) return { ok: false, code: 'not_found' }

  const full = await withTenant(v.tenantId, v.actorId, tx => tx.select({
    requirementsHtml: vacancies.requirementsHtml, dutiesHtml: vacancies.dutiesHtml, publicLanguage: vacancies.publicLanguage,
  }).from(vacancies).where(eq(vacancies.id, vacancyId)).then(r => r[0]))

  const aiInput: VacancyCriteriaInput = {
    title: vac.title, city: vac.city, employmentType: vac.employmentType,
    requirementsHtml: full?.requirementsHtml ?? null, dutiesHtml: full?.dutiesHtml ?? null,
    language: (full?.publicLanguage as VacancyCriteriaInput['language']) ?? 'uk',
  }
  const generationId = randomUUID()
  const journalInput = { requirementsPresent: Boolean(full?.requirementsHtml), dutiesPresent: Boolean(full?.dutiesHtml) }

  const r = await callModel({ tenantId: v.tenantId, actorId: v.actorId }, VACANCY_CRITERIA_PROMPT, aiInput, {
    ref: { kind: 'vacancy_generation', id: generationId },
    async persist(tx, generated, call) {
      await tx.insert(vacancyAiGenerations).values({
        id: generationId, tenantId: v.tenantId, vacancyId, target: 'criteria', input: journalInput,
        outputChars: JSON.stringify(generated.criteria).length, model: call.model.modelName, opsCharged: 1, status: 'ok', authorId: v.actorId,
      })
      await recordAudit(tx, { tenantId: v.tenantId, actorId: v.actorId, action: 'vacancy.ai_criteria_generated', entity: 'vacancy', entityId: vacancyId, after: { generationId, count: generated.criteria.length, aiCallId: call.callId } })
    },
  })
  if (!r.ok) return recordFailure(v, vacancyId, generationId, 'criteria', journalInput, r)
  return { ok: true, criteria: r.output.criteria, generationId }
}

export type AcknowledgeResult = { ok: true, vacancy: VacancyCard } | { ok: false, code: 'not_found' }

/** «Текст перевірено» (§7.9): без правки, но с явным подтверждением человека — публикация разблокируется. */
export async function acknowledgeAiText(v: Viewer, vacancyId: string, generationId: string): Promise<AcknowledgeResult> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const row = await rowById(tx, v, vacancyId)
    if (!row) return { ok: false, code: 'not_found' }
    const [gen] = await tx.select().from(vacancyAiGenerations).where(eq(vacancyAiGenerations.id, generationId))
    if (!gen || gen.vacancyId !== vacancyId || gen.target === 'criteria') return { ok: false, code: 'not_found' }
    const [full] = await tx.select({ aiBlocks: vacancies.aiBlocks }).from(vacancies).where(eq(vacancies.id, vacancyId))
    const aiBlocks = { ...(full?.aiBlocks as Record<string, { acknowledged?: boolean, editedAt?: string | null } | undefined> ?? {}) }
    const block = aiBlocks[gen.target] ?? {}
    aiBlocks[gen.target] = { ...block, acknowledged: true }
    await tx.update(vacancies).set({ aiBlocks, updatedAt: new Date() }).where(eq(vacancies.id, vacancyId))
    await recordAudit(tx, { tenantId: v.tenantId, actorId: v.actorId, action: 'vacancy.ai_text_acknowledged', entity: 'vacancy', entityId: vacancyId, after: { target: gen.target, generationId } })
    return { ok: true, vacancy: await cardOf(tx, row) }
  })
}
