import { eq } from 'drizzle-orm'
import { vacancies, vacancyAiGenerations } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { checkLimit, type LimitCheck } from './tenantLimits'
import { currentUsage, recordUsage } from './usageCounters'
import { recordAudit } from './audit'
import { rowById, cardOf } from './vacancies'
import type { Viewer, VacancyCard } from './vacancies'
import type { VacancyAiTextRequestInput } from '../../shared/schemas/vacancies'
import { VACANCY_AI_CRITERIA_MAX, VACANCY_AI_TEXT_MAX_CHARS } from '../../shared/enums'

/**
 * Генерация текста вакансии и черновика критериев (`docs/v2/29-vacancies.md` §7.10–§7.11,
 * §3.6, §3.10, план `45` PR-17).
 *
 * **ИИ не принимает решений о людях** (инвариант 18, `docs/v2/28` §7.4): здесь генерируется
 * только текст вакансии и черновик критериев для человека — ни одна строка `vacancy_criteria`
 * не появляется без явного «Зберегти критерії» (§7.11), ни один кандидат не оценивается.
 *
 * **Провайдер модели — заглушка** (`docs/v2/HANDOFF.md` §6): детерминированный шаблон, без
 * сети и без ключа. Настоящий `ai_providers` (PR-27) придёт позже под тот же интерфейс
 * `AiTextProvider`, вызывающий код (эта функция) не изменится.
 */

export interface AiTextInput {
  target: 'description' | 'requirements' | 'duties' | 'extra'
  tone: string | null
  title: string
  city: string | null
  employmentType: string | null
  workFormat: string | null
  experienceLevel: string | null
  educationLevel: string | null
  /** Уже заполненные соседние блоки — модель видит контекст, но не сочиняет вразрез с ним. */
  siblingBlocks: Record<string, string | null>
  language: 'uk' | 'en' | 'ru'
}

export interface AiCriterionDraft { name: string, description: string, weight: number }
export interface AiCriteriaInput {
  title: string
  city: string | null
  employmentType: string | null
  requirementsHtml: string | null
  dutiesHtml: string | null
  language: 'uk' | 'en' | 'ru'
}

export interface AiTextProvider {
  generateText(input: AiTextInput): Promise<{ html: string, model: string }>
  generateCriteria(input: AiCriteriaInput): Promise<{ criteria: AiCriterionDraft[], model: string }>
}

const TARGET_LABEL_UK: Record<AiTextInput['target'], string> = {
  description: 'Ми шукаємо людину на позицію',
  requirements: 'Ми очікуємо',
  duties: 'Основні обов’язки',
  extra: 'Додатково пропонуємо',
}

function stripHtml(html: string | null): string {
  return (html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Заглушка (`[решение]`, `docs/v2/46-progress.md` PR-17): шаблон по полям вакансии, без
 * обращения к какому-либо провайдеру. Детерминирована по входу — та же вакансия и та же цель
 * дают тот же текст, что упрощает тесты и не удивляет рекрутера при повторном нажатии.
 */
export const STUB_AI_PROVIDER: AiTextProvider = {
  async generateText(input) {
    const head = `${TARGET_LABEL_UK[input.target]} «${input.title}»`
    const bits = [
      input.city ? `Місце роботи: ${input.city}.` : null,
      input.employmentType ? `Формат зайнятості: ${input.employmentType}.` : null,
      input.workFormat ? `Формат роботи: ${input.workFormat}.` : null,
      input.experienceLevel ? `Досвід: ${input.experienceLevel}.` : null,
      input.educationLevel ? `Освіта: ${input.educationLevel}.` : null,
      input.tone ? `Тон: ${input.tone}.` : null,
    ].filter(Boolean)
    const html = `<p>${head}.</p>${bits.length ? `<p>${bits.join(' ')}</p>` : ''}`
    return { html: html.slice(0, VACANCY_AI_TEXT_MAX_CHARS), model: 'stub-template-v1' }
  },
  async generateCriteria(input) {
    const req = stripHtml(input.requirementsHtml)
    const dut = stripHtml(input.dutiesHtml)
    const base: AiCriterionDraft[] = [
      { name: 'Відповідність вимогам вакансії', description: req ? req.slice(0, 200) : `Досвід і навички під позицію «${input.title}»`, weight: 3 },
      { name: 'Комунікація', description: 'Ясність і доброзичливість у спілкуванні на відборі', weight: 1 },
      { name: 'Готовність до обов’язків', description: dut ? dut.slice(0, 200) : 'Розуміння того, що доведеться робити щодня', weight: 2 },
    ]
    if (input.city) base.push({ name: 'Локація', description: `Готовність працювати у місті ${input.city}`, weight: 1 })
    // База — 3–4 пункта, что уже внутри диапазона §7.11 (3–8); слайс — предохранитель, а не рабочая логика.
    return { criteria: base.slice(0, VACANCY_AI_CRITERIA_MAX), model: 'stub-template-v1' }
  },
}

export type GenerateTextResult
  = | { ok: true, html: string, generationId: string }
    | { ok: false, code: 'not_found' }
    | { ok: false, code: 'limit_exceeded', check: LimitCheck }

/**
 * `POST /vacancies/:id/ai-text` (§7.10, критерии §13 к. 9, 10). Вход модели — только то, что
 * §7.10 разрешает: без вилки, контактов, названия курса и критериев оценки. Одна генерация =
 * 1 `ai_generate_ops`, списывается **после успеха**; повтор того же блока — новая операция.
 */
export async function generateVacancyText(v: Viewer, vacancyId: string, input: VacancyAiTextRequestInput): Promise<GenerateTextResult> {
  const used = await currentUsage(v.tenantId, 'ai_generate_ops')
  const check = await checkLimit(v.tenantId, 'ai_generate_ops', used, 1)

  const vac = await withTenant(v.tenantId, v.actorId, tx => rowById(tx, v, vacancyId))
  if (!vac) return { ok: false, code: 'not_found' }

  if (!check.ok) {
    await withTenant(v.tenantId, v.actorId, tx => tx.insert(vacancyAiGenerations).values({
      tenantId: v.tenantId, vacancyId, target: input.target,
      input: { target: input.target, tone: input.tone ?? null },
      opsCharged: 0, status: 'limited', errorCode: 'limit_exceeded', authorId: v.actorId,
    }))
    return { ok: false, code: 'limit_exceeded', check }
  }

  const full = await withTenant(v.tenantId, v.actorId, async (tx) => {
    const [row] = await tx.select({
      descriptionHtml: vacancies.descriptionHtml, requirementsHtml: vacancies.requirementsHtml,
      dutiesHtml: vacancies.dutiesHtml, extraHtml: vacancies.extraHtml, aiBlocks: vacancies.aiBlocks,
      publicLanguage: vacancies.publicLanguage,
    }).from(vacancies).where(eq(vacancies.id, vacancyId))
    return row
  })

  const aiInput: AiTextInput = {
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
    language: (full?.publicLanguage as AiTextInput['language']) ?? 'uk',
  }
  const generated = await STUB_AI_PROVIDER.generateText(aiInput)

  const generationId = await withTenant(v.tenantId, v.actorId, async (tx) => {
    const column = `${input.target}Html` as 'descriptionHtml' | 'requirementsHtml' | 'dutiesHtml' | 'extraHtml'
    const aiBlocks = { ...(full?.aiBlocks as Record<string, unknown> ?? {}) }
    aiBlocks[input.target] = {
      generatedAt: new Date().toISOString(), generatedBy: v.actorId, model: generated.model,
      promptHash: null, editedAt: null, charsAtGeneration: generated.html.length, acknowledged: false,
    }
    await tx.update(vacancies).set({ [column]: generated.html, aiBlocks, updatedAt: new Date() } as Partial<typeof vacancies.$inferInsert>)
      .where(eq(vacancies.id, vacancyId))
    const [gen] = await tx.insert(vacancyAiGenerations).values({
      tenantId: v.tenantId, vacancyId, target: input.target,
      input: { target: input.target, tone: input.tone ?? null, siblingBlocks: Object.keys(aiInput.siblingBlocks).filter(k => aiInput.siblingBlocks[k]) },
      outputChars: generated.html.length, model: generated.model, opsCharged: 1, status: 'ok', authorId: v.actorId,
    }).returning({ id: vacancyAiGenerations.id })
    await recordAudit(tx, {
      tenantId: v.tenantId, actorId: v.actorId, action: 'vacancy.ai_text_generated', entity: 'vacancy', entityId: vacancyId,
      after: { target: input.target, generationId: gen!.id, chars: generated.html.length },
    })
    return gen!.id
  })
  await recordUsage(v.tenantId, 'ai_generate_ops', 1, { refKind: 'ai_generation', refId: generationId, actorUserId: v.actorId }).catch(() => null)

  return { ok: true, html: generated.html, generationId }
}

export type GenerateCriteriaResult
  = | { ok: true, criteria: AiCriterionDraft[], generationId: string }
    | { ok: false, code: 'not_found' }
    | { ok: false, code: 'limit_exceeded', check: LimitCheck }

/** `POST /vacancies/:id/criteria/generate` (§7.11): черновик, ничего не сохраняется без «Зберегти критерії». */
export async function generateVacancyCriteria(v: Viewer, vacancyId: string): Promise<GenerateCriteriaResult> {
  const used = await currentUsage(v.tenantId, 'ai_generate_ops')
  const check = await checkLimit(v.tenantId, 'ai_generate_ops', used, 1)

  const vac = await withTenant(v.tenantId, v.actorId, tx => rowById(tx, v, vacancyId))
  if (!vac) return { ok: false, code: 'not_found' }

  if (!check.ok) {
    await withTenant(v.tenantId, v.actorId, tx => tx.insert(vacancyAiGenerations).values({
      tenantId: v.tenantId, vacancyId, target: 'criteria', input: {}, opsCharged: 0, status: 'limited', errorCode: 'limit_exceeded', authorId: v.actorId,
    }))
    return { ok: false, code: 'limit_exceeded', check }
  }

  const full = await withTenant(v.tenantId, v.actorId, tx => tx.select({
    requirementsHtml: vacancies.requirementsHtml, dutiesHtml: vacancies.dutiesHtml, publicLanguage: vacancies.publicLanguage,
  }).from(vacancies).where(eq(vacancies.id, vacancyId)).then(r => r[0]))

  const generated = await STUB_AI_PROVIDER.generateCriteria({
    title: vac.title, city: vac.city, employmentType: vac.employmentType,
    requirementsHtml: full?.requirementsHtml ?? null, dutiesHtml: full?.dutiesHtml ?? null,
    language: (full?.publicLanguage as AiCriteriaInput['language']) ?? 'uk',
  })

  const generationId = await withTenant(v.tenantId, v.actorId, async (tx) => {
    const [gen] = await tx.insert(vacancyAiGenerations).values({
      tenantId: v.tenantId, vacancyId, target: 'criteria',
      input: { requirementsPresent: Boolean(full?.requirementsHtml), dutiesPresent: Boolean(full?.dutiesHtml) },
      outputChars: JSON.stringify(generated.criteria).length, model: generated.model, opsCharged: 1, status: 'ok', authorId: v.actorId,
    }).returning({ id: vacancyAiGenerations.id })
    await recordAudit(tx, { tenantId: v.tenantId, actorId: v.actorId, action: 'vacancy.ai_criteria_generated', entity: 'vacancy', entityId: vacancyId, after: { generationId: gen!.id, count: generated.criteria.length } })
    return gen!.id
  })
  await recordUsage(v.tenantId, 'ai_generate_ops', 1, { refKind: 'ai_generation', refId: generationId, actorUserId: v.actorId }).catch(() => null)

  return { ok: true, criteria: generated.criteria, generationId }
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
