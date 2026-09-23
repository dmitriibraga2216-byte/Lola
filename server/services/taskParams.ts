import { and, desc, eq } from 'drizzle-orm'
import { assignments, enrollments, lessons, tenants } from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { resolveAudience } from './audience'
import { courseStage, stageCan } from './lifecycle'
import type { StageLike } from './lifecycle'
import { DEFAULT_QUIZ_PARAMS } from '../../shared/domain/grading'
import type { QuizParams } from '../../shared/domain/grading'
import { PARAM_KEYS_BY_CONTENT_TYPE, paramsFor } from '../../shared/schemas/assignments'
import type { AssignmentParams, Audience } from '../../shared/schemas/assignments'
import type { ContentType, StageCapability } from '../../shared/enums'

/**
 * Откуда берутся правила прохождения (CLAUDE.md п. 11, docs/15 §14.3): только из назначения.
 * Контент правил не хранит. Порядок поиска:
 *   1. запись (enrollment) → её назначение → params; порог теста в плане курса
 *      (lessons.pass_score_pct) перекрывает порог назначения только для этого элемента;
 *   2. активное назначение этого контента, в аудиторию которого входит человек (новейшее);
 *   3. значения по умолчанию тенанта (tenants.settings.learning.quizDefaults) поверх системных.
 * Результат копируется в attempts.params при старте и дальше не меняется.
 */
export interface ParamsSource { assignmentId: string | null, source: 'enrollment' | 'assignment' | 'tenant_default' }

// ── Возможности этапа фильтруют ключи params (docs/v2/39-patches.md П-15, docs/v2/33 §7.5) ──

/**
 * Какая возможность этапа отвечает за какой ключ `params` назначения.
 *
 * Правила прохождения остаются **в назначении** (CLAUDE.md п. 11): этап не хранит ни попыток,
 * ни порога, ни срока — он лишь ограничивает набор ключей, которые назначению позволено
 * сохранить. Если возможность выключена, ключ **не сохраняется вовсе** — а не сохраняется со
 * значением по умолчанию (П-15: иначе у курса базы знаний в `params` окажется `deadlineMode`,
 * и отчёт «нарушены сроки» начнёт считать нарушения там, где сроков нет).
 *
 * Таблица построена по группам параметров `docs/15` §14.3 и колонке «Что ломается, если
 * выключить» таблицы возможностей `33` §3.3:
 * - `deadline` («поле срока скрыто в форме назначения») — вся группа «Термін виконання»;
 * - `attempts` («поле попыток скрыто») — «Спроби» с паузой между ними;
 * - `grading` («нет баллов, нет пройдено/провалено») — вся группа «Результат»;
 * - `certificate` («блок сертификата скрыт») — награда-сертификат;
 * - `counts_in_rating` («назначения этапа не влияют на рейтинг») — баллы рейтинга.
 *
 * Чего здесь намеренно нет: `progress`, `review`, `graph`, `ai_generate`,
 * `applies_to_*` — они меняют экраны, очередь проверки, конструктор и назначение кандидату,
 * но ни одного ключа `params` не адресуют. Значки `badgeId`/`bonuses` — геймификация магазина
 * подарков, а не рейтинг (`38`), и отдельной возможностью не закрыты. Выдумывать для них
 * ключи запрещено (CLAUDE.md «Чего не делать»).
 */
export const PARAM_KEY_CAPABILITY: Readonly<Record<string, StageCapability>> = {
  deadlineMode: 'deadline',
  timeLimitSec: 'deadline',
  attemptsAllowed: 'attempts',
  attemptCooldownMin: 'attempts',
  resultSource: 'grading',
  passScore: 'grading',
  fixResult: 'grading',
  scaleId: 'grading',
  certificateId: 'certificate',
  points: 'counts_in_rating',
}

/**
 * Этап носителя назначения. Этап есть только у курса (`33` §3.4 — колонка `courses.lifecycle_stage_id`);
 * тест, практикум, ресурс и прочие типы контента этапа не имеют и работают с полным набором
 * возможностей, как в базовом ТЗ. `null` = полный набор (`stageCan(null, …) === true`).
 */
export async function subjectStage(tx: TenantTx, contentType: ContentType, subjectId: string): Promise<StageLike | null> {
  if (contentType !== 'course') return null
  return courseStage(tx, subjectId)
}

/**
 * Ключи `params`, которые назначение этого типа контента на курс этого этапа вправе сохранить.
 * Форма назначения показывает ровно их (`33` §7.5: «форма читает возможности этапа и скрывает
 * неприменимые поля») — состав полей приходит с сервера, чтобы решение принималось в одном месте.
 */
export function stageParamKeys(contentType: ContentType, stage: StageLike | null): readonly string[] {
  return PARAM_KEYS_BY_CONTENT_TYPE[contentType].filter(k => stageAllowsParam(stage, k))
}

/** Разрешает ли этап этот ключ. Единственная ветка по этапу — `stageCan()` (`33` §7.1). */
export function stageAllowsParam(stage: StageLike | null, key: string): boolean {
  const capability = PARAM_KEY_CAPABILITY[key]
  return capability === undefined || stageCan(stage, capability)
}

/**
 * **Одна точка** фильтра ключей `params` (план `45` PR-06): сначала состав по типу контента
 * (`paramsFor()`), затем возможности этапа. Ключ выключенной возможности отбрасывается молча —
 * так предписывает П-15 («не сохраняет»), и так же ведёт себя фильтр по типу контента: форма
 * поля не показывает, а хранилище лишнего не принимает.
 */
export async function stageParamsFor(
  tx: TenantTx,
  contentType: ContentType,
  subjectId: string,
  params: Record<string, unknown> | undefined,
): Promise<AssignmentParams> {
  const byType = paramsFor(contentType, params ?? {})
  const stage = await subjectStage(tx, contentType, subjectId)
  if (!stage) return byType
  return Object.fromEntries(Object.entries(byType).filter(([k]) => stageAllowsParam(stage, k))) as AssignmentParams
}

export async function tenantQuizDefaults(tx: TenantTx, tenantId: string): Promise<QuizParams> {
  const [t] = await tx.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId))
  const s = (t?.settings ?? {}) as { learning?: { quizDefaults?: Partial<QuizParams> } }
  return { ...DEFAULT_QUIZ_PARAMS, ...(s.learning?.quizDefaults ?? {}) }
}

/** Новейшее активное назначение контента, в аудиторию которого входит человек. */
export async function findAssignmentFor(tx: TenantTx, contentType: ContentType, contentId: string, userId: string) {
  const rows = await tx.select({ id: assignments.id, params: assignments.params, audience: assignments.audience, exclude: assignments.exclude })
    .from(assignments)
    .where(and(eq(assignments.subjectType, contentType), eq(assignments.subjectId, contentId), eq(assignments.status, 'active')))
    .orderBy(desc(assignments.createdAt))
  for (const a of rows) {
    const set = await resolveAudience(tx, a.audience as Audience, a.exclude as Audience)
    if (set.has(userId)) return a
  }
  return null
}

export async function resolveQuizParams(
  tx: TenantTx,
  input: { tenantId: string, userId: string, quizId: string, enrollmentId?: string | null, lessonId?: string | null },
): Promise<{ params: QuizParams } & ParamsSource> {
  const defaults = await tenantQuizDefaults(tx, input.tenantId)

  if (input.enrollmentId) {
    const [e] = await tx.select({ assignmentId: enrollments.assignmentId }).from(enrollments).where(eq(enrollments.id, input.enrollmentId))
    let params: QuizParams = { ...defaults }
    let assignmentId: string | null = null
    if (e?.assignmentId) {
      const [a] = await tx.select({ params: assignments.params }).from(assignments).where(eq(assignments.id, e.assignmentId))
      if (a) { params = { ...params, ...(a.params as Partial<QuizParams>) }; assignmentId = e.assignmentId }
    }
    if (input.lessonId) {
      const [l] = await tx.select({ passScorePct: lessons.passScorePct }).from(lessons).where(eq(lessons.id, input.lessonId))
      if (l?.passScorePct != null) params.passScore = Number(l.passScorePct)
    }
    return { params, assignmentId, source: assignmentId ? 'enrollment' : 'tenant_default' }
  }

  const a = await findAssignmentFor(tx, 'test', input.quizId, input.userId)
  if (a) return { params: { ...defaults, ...(a.params as Partial<QuizParams>) }, assignmentId: a.id, source: 'assignment' }
  return { params: defaults, assignmentId: null, source: 'tenant_default' }
}

/** Комплексный тест: те же правила поиска, без урока. */
export async function resolveComplexParams(tx: TenantTx, input: { tenantId: string, userId: string, complexTestId: string }) {
  const defaults = await tenantQuizDefaults(tx, input.tenantId)
  const a = await findAssignmentFor(tx, 'complex_test', input.complexTestId, input.userId)
  if (a) return { params: { ...defaults, ...(a.params as Partial<QuizParams>) }, assignmentId: a.id, source: 'assignment' as const }
  return { params: defaults, assignmentId: null, source: 'tenant_default' as const }
}
