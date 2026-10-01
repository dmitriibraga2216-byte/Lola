import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm'
import { courseVersions, courses, libraryModules, lessons, lifecycleStages, modules } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { LimitCheck } from './tenantLimits'
import { recordAudit } from './audit'
import { slugify } from './courses'
import { stageCan } from './lifecycle'
import { attachTx, type AttachFailCode } from './libraryUsages'
import type { LibraryActor } from './library'
import { callModel } from './ai/gateway'
import type { AiUnavailableReason } from './ai/policy'
import { TRACK_DRAFT_PROMPT } from './ai/prompts'
import type { TrackDraftInput, TrackDraftModule } from './ai/prompts'
import { TRACK_AI_POOL_MAX } from '../../shared/enums'
import type { TrackGenerateInput } from '../../shared/schemas/content'

/**
 * «Згенерувати трек» (`docs/v2/35` §7.1, §7.7 п. 4, критерий к. 4; решение — `44` Р-BT.3).
 *
 * Самая узкая трактовка, которую допускает ТЗ (в Lola «трек» — это курс, `00-comparison` К-7,
 * `33` §3.1):
 * - **из того, что уже есть у тенанта.** Модель не пишет учебный контент: она получает цель
 *   от человека и список **опубликованных** модулей библиотеки (`31`) и предлагает название,
 *   описание и разделы, раскладывая по ним эти модули. Номер вне пула отбрасывается;
 * - **черновик.** Результат — курс `draft` с черновой версией 1, уроки — ссылки на модули
 *   (`library_module_usages`, как ручная вставка). Публикует человек обычным путём (`course.publish`),
 *   назначений нет и автоматически не создаётся (инвариант 18 — ИИ не решает о людях);
 * - **через шлюз** (`ai/gateway.ts`): роль `generate`, строка `ai_calls` с `ref_kind = 'course'`
 *   и `ref_id` — созданный курс, ось `ai_generate_ops`. Курс, уроки и списание операции — одна
 *   транзакция: отказ по лимиту, истёкший ИИ (`ai_status = 'expired'`, `35` §7.7 п. 4) или
 *   упавший провайдер не создают ничего и ничего не списывают;
 * - **этап** — необязателен; если указан, он должен быть включён и разрешать генерацию
 *   (`stageCan(stage, 'ai_generate')`, `33` §3.3: у `attestation` — нет). Курс без этапа работает
 *   с полным набором возможностей (`33` §7.3).
 */

export type GenerateTrackResult
  = | { ok: true, courseId: string, title: string, sections: number, lessons: number, aiCallId: number }
    | { ok: false, code: 'stage_not_found' | 'stage_disabled' | 'stage_ai_forbidden' | 'no_modules' | 'empty_plan' }
    | { ok: false, code: 'limit_exceeded', check: LimitCheck }
    | { ok: false, code: 'ai_unavailable', reason: AiUnavailableReason }
    /** `reason`: `no_provider` — у роли нет активного профиля, иначе последний код отказа провайдера. */
    | { ok: false, code: 'provider_failed', reason: string }

/** Ответ модели не дал ни одного урока из пула — откатываем транзакцию, операция не списывается. */
class EmptyPlan extends Error {}

/** Модуль пула пропал между чтением и записью (архивирован, снят) — тоже откат, а не полупустой курс. */
class AttachFailed extends Error {
  constructor(readonly code: AttachFailCode) { super(code) }
}

export async function generateTrack(actor: LibraryActor, input: TrackGenerateInput): Promise<GenerateTrackResult> {
  const pre = await withTenant(actor.tenantId, actor.actorId, async (tx) => {
    if (input.lifecycleStageId) {
      const [stage] = await tx.select().from(lifecycleStages).where(eq(lifecycleStages.id, input.lifecycleStageId))
      if (!stage) return { ok: false as const, code: 'stage_not_found' as const }
      if (!stage.isEnabled) return { ok: false as const, code: 'stage_disabled' as const }
      if (!stageCan(stage, 'ai_generate')) return { ok: false as const, code: 'stage_ai_forbidden' as const }
    }
    // Пул — опубликованные и не архивные модули; выбранные человеком — только из них же
    const where = [isNotNull(libraryModules.currentVersionId), ne(libraryModules.status, 'archived')]
    if (input.libraryModuleIds?.length) where.push(inArray(libraryModules.id, input.libraryModuleIds))
    const pool = await tx.select({
      id: libraryModules.id, title: libraryModules.title, summary: libraryModules.summary, minutes: libraryModules.estimatedMinutes,
    }).from(libraryModules).where(and(...where))
      .orderBy(desc(libraryModules.usageCount), desc(libraryModules.updatedAt))
      .limit(TRACK_AI_POOL_MAX)
    if (!pool.length) return { ok: false as const, code: 'no_modules' as const }
    // Выбранные человеком — в его порядке: модель видит их так, как он их перечислил
    const order = new Map((input.libraryModuleIds ?? []).map((id, i) => [id, i]))
    if (order.size) pool.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
    return { ok: true as const, pool }
  })
  if (!pre.ok) return pre

  const byN = new Map(pre.pool.map((m, i) => [i + 1, m]))
  const aiInput: TrackDraftInput = {
    goal: input.goal,
    language: input.language,
    modules: pre.pool.map((m, i): TrackDraftModule => ({ n: i + 1, title: m.title, summary: m.summary, minutes: m.minutes })),
  }
  const courseId = randomUUID()
  let built: { title: string, sections: number, lessons: number } | null = null

  try {
    const r = await callModel({ tenantId: actor.tenantId, actorId: actor.actorId }, TRACK_DRAFT_PROMPT, aiInput, {
      ref: { kind: 'course', id: courseId },
      async persist(tx, draft, call) {
        // Каждый модуль — не больше одного раза во всём треке, номера вне пула — мимо
        const seen = new Set<number>()
        const fresh = (n: number) => {
          if (!byN.has(n) || seen.has(n)) return false
          seen.add(n)
          return true
        }
        const sections = draft.sections
          .map(s => ({ title: s.title, items: s.modules.filter(fresh) }))
          .filter(s => s.items.length)
        if (!sections.length) throw new EmptyPlan()

        const [course] = await tx.insert(courses).values({
          id: courseId,
          tenantId: actor.tenantId,
          title: draft.title,
          slug: `${slugify(draft.title) || 'track'}-${courseId.slice(0, 6)}`,
          // Описание курса — до 300 знаков (форма карточки, `courseCreateSchema`)
          summary: draft.summary ? draft.summary.slice(0, 300) : null,
          language: input.language,
          lifecycleStageId: input.lifecycleStageId ?? null,
          createdBy: actor.actorId,
        }).returning()
        const [version] = await tx.insert(courseVersions).values({ tenantId: actor.tenantId, courseId, version: 1, status: 'draft' }).returning()

        let lessonCount = 0
        for (const [si, s] of sections.entries()) {
          const [mod] = await tx.insert(modules).values({ tenantId: actor.tenantId, courseVersionId: version!.id, title: s.title, sort: si }).returning()
          for (const [li, n] of s.items.entries()) {
            const m = byN.get(n)!
            // Урок-место: материал и снимок проставит вставка модуля (`attachTx`), как при ручной вставке
            const [lesson] = await tx.insert(lessons).values({
              tenantId: actor.tenantId, moduleId: mod!.id, title: m.title, sort: li, itemType: 'resource', itemId: m.id,
            }).returning({ id: lessons.id })
            const att = await attachTx(tx, actor, {
              libraryModuleId: m.id, holderType: 'course_lesson', holderId: lesson!.id, containerType: 'course', containerId: courseId, pinMode: 'hotfix_auto',
            })
            if (!att.ok) throw new AttachFailed(att.code)
            lessonCount++
          }
        }

        await recordAudit(tx, {
          tenantId: actor.tenantId, actorId: actor.actorId, action: 'course.ai_generated', entity: 'course', entityId: courseId,
          after: { title: course!.title, sections: sections.length, lessons: lessonCount, lifecycleStageId: input.lifecycleStageId ?? null, aiCallId: call.callId, model: call.model.modelName },
        })
        built = { title: course!.title, sections: sections.length, lessons: lessonCount }
      },
    })
    if (r.ok && built) {
      const b = built as { title: string, sections: number, lessons: number }
      return { ok: true, courseId, title: b.title, sections: b.sections, lessons: b.lessons, aiCallId: r.callId }
    }
    if (!r.ok) {
      if (r.code === 'limit_exceeded' && r.check) return { ok: false, code: 'limit_exceeded', check: r.check }
      if (r.code === 'ai_unavailable' && r.reason) return { ok: false, code: 'ai_unavailable', reason: r.reason }
      return { ok: false, code: 'provider_failed', reason: r.code === 'provider_failed' ? r.providerError ?? r.code : r.code }
    }
    return { ok: false, code: 'empty_plan' }
  }
  catch (err) {
    // Шлюз пометил вызов `failed` / `persist_failed`; курса нет, операция не списана
    if (err instanceof EmptyPlan) return { ok: false, code: 'empty_plan' }
    if (err instanceof AttachFailed) return { ok: false, code: 'no_modules' }
    throw err
  }
}
