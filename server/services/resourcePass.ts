import { and, eq, isNull, sql } from 'drizzle-orm'
import { assignments, mediaAssets, resourceProgress, resources, trajectories } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import type { ContentBlock, TickInput } from '../../shared/schemas/content'
import { COMPLETION_RULES } from '../../shared/schemas/resources'
import type { ResourceKind } from '../../shared/schemas/resources'
import type { Audience } from '../../shared/schemas/assignments'
import { evaluateLesson, reasonCodes } from './lessonRules'
import type { Evaluation, LessonFacts, ProgressFacts, ReasonCode } from './lessonRules'
import { TICK_MAX_SECONDS, TICK_MIN_INTERVAL_MS } from './learning'
import { canAccessResource, currentVersion, printAllowed } from './resources'
import { resolveAudience } from './audience'
import { logTaskAccess } from './journals'

/**
 * Прохождение ресурса **как задания** — вне курса (docs/11 Г-11.5; docs/17 §14.3 — блок «Завдання»
 * ссылается на любой назначаемый тип): узел траектории, прямое назначение, элемент программы.
 *
 * До этого модуля у такого ресурса не было ни экрана прохождения, ни правила зачёта: просмотр
 * (`viewResource`) писал «виконано» с первого открытия и при этом не двигал ни траекторию, ни
 * программу — узел с материалом навсегда оставался «доступен». Здесь та же пара, что у урока курса
 * (`learning.ts`: open → tick → acknowledge/download → complete): клиент присылает факты, сервер
 * решает по правилу типа материала (`evaluateLesson`, Г-11.5 — «открытия мало»), а зачёт идёт
 * через **те же** хуки результата, что у курса, теста, практикума и заняття: `onTaskResult`
 * траекторий и `onItemResult` программ. Своего пути засчитывания узла здесь нет.
 *
 * Контекст — назначение, по которому человек проходит материал (`assignmentId`): оно закрепляет
 * версию (D-007) и само даёт доступ (человек в его аудитории). Без назначения — элемент программы:
 * текущая опубликованная версия при доступе по группам базы знаний.
 */

interface Ctx { tenantId: string, actorId: string }
type Progress = typeof resourceProgress.$inferSelect
type Version = NonNullable<Awaited<ReturnType<typeof currentVersion>>>

/** Откуда человек пришёл: экран возвращает его туда же (лента траектории). */
export type PassContext = { type: 'trajectory', enrollmentId: string, title: string | null }

/** Состояние прохождения для экрана: факты, готовность по правилу типа и коды того, чего не хватает. */
export interface PassState extends Evaluation {
  status: 'opened' | 'completed'
  secondsSpent: number
  scrollPct: number
  videoPct: number
  acknowledged: boolean
  downloaded: boolean
  blocksState: Record<string, unknown>
  /** Коды причин (`lessonRules.REASONS`, `time`) — экран переводит их на язык интерфейса. */
  missing: ReasonCode[]
}

export type OpenPassResult
  = | { ok: true, resource: PassResource, progress: PassState, context: PassContext | null }
    | { ok: false, code: 'not_found' }

export interface PassResource {
  id: string
  title: string
  kind: ResourceKind
  body: ContentBlock[]
  mediaId: string | null
  externalUrl: string | null
  version: number
  versionId: string
  /** Назначение закрепило версию на момент выдачи (D-007). */
  pinned: boolean
  estimatedMinutes: number | null
  canPrint: boolean
  /** Порог просмотра видео по правилу типа (Г-11.5) — для подписи «Подивись відео до кінця». */
  videoThresholdPct: number
}

export type CompletePassResult
  = | { ok: true, completedNow: boolean }
    | { ok: false, code: 'not_found' }
    | { ok: false, code: 'conditions_not_met', reasons: string[], missing: ReasonCode[] }

// ── Доступ и материал ─────────────────────────────────────────────────────────────────

interface Target { resource: typeof resources.$inferSelect, version: Version, assignmentId: string | null, pinned: boolean, context: PassContext | null }

/**
 * Что человек проходит. По назначению: назначение этого ресурса, активное, человек в его аудитории —
 * тогда доступ даёт само назначение, а версия — закреплённый снимок (он же читается и у тела модуля
 * библиотеки, которое ресурсом не публикуется). Без назначения — только опубликованный ресурс при
 * доступе по группам (`canAccessResource`). Чужой тенант, чужое назначение — null (404, CLAUDE.md п. 15).
 */
async function resolveTarget(tx: TenantTx, ctx: Ctx, resourceId: string, assignmentId?: string | null): Promise<Target | null> {
  const [r] = await tx.select().from(resources).where(and(eq(resources.id, resourceId), isNull(resources.deletedAt)))
  if (!r) return null
  if (assignmentId) {
    const [a] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId))
    if (!a || a.subjectType !== 'resource' || a.subjectId !== resourceId || a.status !== 'active') return null
    if (!(await resolveAudience(tx, a.audience as Audience, a.exclude as Audience)).has(ctx.actorId)) return null
    const version = await currentVersion(tx, resourceId, a.subjectVersionId)
    if (!version) return null
    return { resource: r, version, assignmentId, pinned: !!a.subjectVersionId, context: await contextOf(tx, a) }
  }
  if (r.status !== 'published' || !(await canAccessResource(tx, ctx.actorId, resourceId))) return null
  const version = await currentVersion(tx, resourceId)
  return version ? { resource: r, version, assignmentId: null, pinned: false, context: null } : null
}

/** Назначение узла траектории несёт свою траекторию и прохождение (`createNodeAssignment`). */
async function contextOf(tx: TenantTx, a: typeof assignments.$inferSelect): Promise<PassContext | null> {
  const aud = a.audience as { trajectoryId?: string, trajectoryEnrollmentId?: string }
  if (a.kind !== 'trajectory' || !aud.trajectoryId || !aud.trajectoryEnrollmentId) return null
  const [t] = await tx.select({ title: trajectories.title }).from(trajectories).where(eq(trajectories.id, aud.trajectoryId))
  return { type: 'trajectory', enrollmentId: aud.trajectoryEnrollmentId, title: t?.title ?? null }
}

/** Факты материала для правила зачёта: тип, тело, объём текста, страницы документа. Порог видео — правило типа (90 %). */
async function materialFacts(tx: TenantTx, v: Version): Promise<LessonFacts> {
  const kind = v.kind as ResourceKind
  let pages: number | null = null
  if (kind === 'file' && v.mediaId) {
    const [m] = await tx.select({ pages: sql<number | null>`(${mediaAssets.variants}->>'pages')::int` }).from(mediaAssets).where(eq(mediaAssets.id, v.mediaId))
    pages = m?.pages ?? null
  }
  return { kind, body: (v.body ?? []) as ContentBlock[], plainText: v.plainText, pages, minSeconds: null, videoThresholdPct: COMPLETION_RULES.video.minPct }
}

/** Снимок, который человек открыл; если его сняли — текущая опубликованная версия. */
async function factsFor(tx: TenantTx, p: Progress): Promise<LessonFacts | null> {
  const v = await currentVersion(tx, p.resourceId, p.resourceVersionId)
  return v ? materialFacts(tx, v) : null
}

function progressFacts(p: Progress): ProgressFacts {
  return {
    secondsSpent: p.secondsSpent,
    scrollPct: p.scrollPct,
    videoPct: p.videoPct,
    acknowledged: !!p.acknowledgedAt,
    downloaded: !!p.downloadedAt,
    blocksState: p.blocksState as Record<string, unknown>,
  }
}

function stateOf(p: Progress, facts: LessonFacts | null): PassState {
  const done = p.status === 'completed'
  const ev: Evaluation = done
    ? { ready: true, reasons: [], requiredSeconds: null }
    : facts ? evaluateLesson(facts, progressFacts(p)) : { ready: false, reasons: [], requiredSeconds: null }
  return {
    status: done ? 'completed' : 'opened',
    ...progressFacts(p),
    ...ev,
    missing: reasonCodes(ev.reasons),
  }
}

const keyOf = (ctx: Ctx, resourceId: string, assignmentId?: string | null) => and(
  eq(resourceProgress.userId, ctx.actorId),
  eq(resourceProgress.resourceId, resourceId),
  assignmentId ? eq(resourceProgress.assignmentId, assignmentId) : isNull(resourceProgress.assignmentId),
)

async function findProgress(tx: TenantTx, ctx: Ctx, resourceId: string, assignmentId?: string | null): Promise<Progress | null> {
  const [p] = await tx.select().from(resourceProgress).where(keyOf(ctx, resourceId, assignmentId))
  return p ?? null
}

// ── Открыть · тик · «Я ознайомився» · скачать · завершить ────────────────────────────

/** Открыть материал: проверить доступ, завести запись прохождения, отдать тело и готовность по правилу типа. */
export async function openResourcePass(ctx: Ctx, resourceId: string, input: { assignmentId?: string, device?: 'mobile' | 'desktop' } = {}): Promise<OpenPassResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const target = await resolveTarget(tx, ctx, resourceId, input.assignmentId)
    if (!target) return { ok: false as const, code: 'not_found' as const }
    const { version } = target
    const [created] = await tx.insert(resourceProgress).values({
      tenantId: ctx.tenantId, userId: ctx.actorId, resourceId, assignmentId: target.assignmentId,
      resourceVersionId: version.id, device: input.device ?? null,
    }).onConflictDoNothing().returning()
    let p = created ?? (await findProgress(tx, ctx, resourceId, target.assignmentId))!
    // Без назначения материал могли переопубликовать: время чтения считается по тому, что человек видит
    if (p.status !== 'completed' && p.resourceVersionId !== version.id) {
      [p] = await tx.update(resourceProgress).set({ resourceVersionId: version.id, updatedAt: new Date() }).where(eq(resourceProgress.id, p.id)).returning() as [Progress]
    }
    // Обращение к заданию — строкой журнала (docs/22 §13.4) и «Переглядів: N» (docs/21 §14.1), как у просмотра
    await tx.update(resources).set({ viewsCount: sql`${resources.viewsCount} + 1` }).where(eq(resources.id, resourceId))
    await logTaskAccess(tx, { tenantId: ctx.tenantId, userId: ctx.actorId, contentType: 'resource', contentId: resourceId, title: version.title, assignmentId: target.assignmentId })
    return {
      ok: true as const,
      resource: {
        id: resourceId, title: version.title, kind: version.kind as ResourceKind, body: (version.body ?? []) as ContentBlock[],
        mediaId: version.mediaId, externalUrl: version.externalUrl, version: version.version, versionId: version.id,
        pinned: target.pinned, estimatedMinutes: target.resource.estimatedMinutes, canPrint: await printAllowed(tx, ctx.tenantId, target.resource.allowPrint),
        videoThresholdPct: COMPLETION_RULES.video.minPct,
      },
      progress: stateOf(p, await materialFacts(tx, version)),
      context: target.context,
    }
  })
}

/**
 * Тик (docs/11 §7.4) — те же правила, что у урока: за тик не больше 20 секунд и не больше реально
 * прошедшего с прошлого тика; тики чаще раза в 10 секунд времени не добавляют; проценты только растут.
 */
export async function tickResourcePass(ctx: Ctx, resourceId: string, input: TickInput & { assignmentId?: string }): Promise<PassState | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const p = await findProgress(tx, ctx, resourceId, input.assignmentId)
    if (!p) return null
    const now = new Date()
    const since = p.lastTickAt ?? p.firstOpenedAt
    const elapsedSec = Math.round((now.getTime() - since.getTime()) / 1000)
    const tooSoon = !!p.lastTickAt && now.getTime() - p.lastTickAt.getTime() < TICK_MIN_INTERVAL_MS
    const addSeconds = tooSoon || p.status === 'completed' ? 0 : Math.max(0, Math.min(input.seconds, TICK_MAX_SECONDS, elapsedSec))
    const [updated] = await tx.update(resourceProgress).set({
      secondsSpent: p.secondsSpent + addSeconds,
      ...(addSeconds > 0 ? { lastTickAt: now } : {}),
      ...(input.blocksState ? { blocksState: { ...(p.blocksState as Record<string, unknown>), ...input.blocksState } } : {}),
      ...(input.videoPct !== undefined ? { videoPct: Math.max(p.videoPct, input.videoPct) } : {}),
      ...(input.scrollPct !== undefined ? { scrollPct: Math.max(p.scrollPct, input.scrollPct) } : {}),
      ...(input.device ? { device: input.device } : {}),
      updatedAt: now,
    }).where(eq(resourceProgress.id, p.id)).returning()
    return stateOf(updated!, await factsFor(tx, updated!))
  })
}

/** «Я ознайомився» для ссылки (Г-11.5); идемпотентно. */
export async function acknowledgeResourcePass(ctx: Ctx, resourceId: string, input: { assignmentId?: string } = {}): Promise<PassState | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [p] = await tx.update(resourceProgress).set({ acknowledgedAt: sql`coalesce(${resourceProgress.acknowledgedAt}, now())`, updatedAt: new Date() })
      .where(keyOf(ctx, resourceId, input.assignmentId)).returning()
    return p ? stateOf(p, await factsFor(tx, p)) : null
  })
}

/** Документ скачан (Г-11.5: «пролистан до конца либо скачан»); скачивание — строкой журнала обращений. */
export async function downloadResourcePass(ctx: Ctx, resourceId: string, input: { assignmentId?: string } = {}): Promise<PassState | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [p] = await tx.update(resourceProgress).set({ downloadedAt: sql`coalesce(${resourceProgress.downloadedAt}, now())`, updatedAt: new Date() })
      .where(keyOf(ctx, resourceId, input.assignmentId)).returning()
    if (!p) return null
    await logTaskAccess(tx, { tenantId: ctx.tenantId, userId: ctx.actorId, contentType: 'resource', contentId: resourceId, assignmentId: p.assignmentId, action: 'download' })
    return stateOf(p, await factsFor(tx, p))
  })
}

/**
 * Завершить: сервер проверяет правило типа (Г-11.5) по фактам записи — 422 с причинами, если
 * не выполнено. Зачёт — `task_status_log` через единый хук (D-020) в той же транзакции, затем,
 * **после фиксации**, те же хуки результата, что у остальных видов узлов: траектории и программы.
 * Хуки ждём, а не бросаем: человек сразу возвращается в ленту траектории, и узел там уже зачтён.
 * Повторное «Завершити» по зачтённой записи ничего не пишет, но хуки зовёт снова — они
 * идемпотентны и дотягивают узел, если прошлый вызов оборвался.
 */
export async function completeResourcePass(ctx: Ctx, resourceId: string, input: { assignmentId?: string } = {}): Promise<CompletePassResult> {
  const res = await withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<CompletePassResult> => {
    const p = await findProgress(tx, ctx, resourceId, input.assignmentId)
    if (!p) return { ok: false, code: 'not_found' }
    if (p.status === 'completed') return { ok: true, completedNow: false }
    const facts = await factsFor(tx, p)
    if (!facts) return { ok: false, code: 'not_found' }
    const ev = evaluateLesson(facts, progressFacts(p))
    if (!ev.ready) return { ok: false, code: 'conditions_not_met', reasons: ev.reasons, missing: reasonCodes(ev.reasons) }
    const now = new Date()
    await tx.update(resourceProgress).set({ status: 'completed', completedAt: now, updatedAt: now }).where(eq(resourceProgress.id, p.id))
    // docs/33 D-020: єдина точка «завдання завершено» — журнал, компетенції призначення, бали, етап
    const { onTaskCompleted } = await import('./taskCompletion')
    await onTaskCompleted(tx, ctx.tenantId, ctx.actorId, { contentType: 'resource', contentId: resourceId, status: 'done', assignmentId: p.assignmentId, sourceKind: 'resource_view', sourceId: p.id })
    return { ok: true, completedNow: true }
  })
  if (res.ok) await resultHooks(ctx, resourceId)
  return res
}

/** Тот же хук результата, что у курса, теста, практикума и заняття (`learning.ts`, `attempts.ts`, …) — после фиксации. */
async function resultHooks(ctx: Ctx, resourceId: string) {
  await import('./trajectories').then(t => t.onTaskResult(ctx.tenantId, ctx.actorId, 'resource', resourceId, { passed: true }))
    .catch(err => console.error('trajectory resource hook', err))
  await import('./programs').then(p => p.onItemResult(ctx.tenantId, ctx.actorId, 'resource', resourceId, { passed: true }))
    .catch(err => console.error('program resource hook', err))
}
