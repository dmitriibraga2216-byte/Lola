import { and, eq, inArray, sql } from 'drizzle-orm'
import { checklistRuns, checklists, locations, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { scopeSql } from './access'
import { frameJoins, frameSelect, frameTail } from './reportFrame'
import type { SQL } from 'drizzle-orm'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { recordActivity } from './activity'
import { loadScale } from './assessment'
import type { ScaleInfo } from './assessment'
import type { ChecklistInput } from '../../shared/schemas/assessment'
import { CHECKLIST_MUTABLE_WHEN_LOCKED } from '../../shared/schemas/assessment'

interface Ctx { tenantId: string, actorId: string }

/**
 * Пункт чек-листа: вес, критичность, фото, подсказка; `criterionId` — ссылка на словарь (docs/20 §14.3). Шкала одна на чек-лист.
 * `passThreshold` (docs/33 D-037) — свій поріг провалу пункта (％ від частки), опційно; без нього пункт провалюється
 * по прохідному балу всього чек-листа (як і раніше).
 */
export interface ChecklistItem { id: string, group?: string, text: string, criterionId?: string, weight: number, isCritical?: boolean, requiresPhoto?: boolean, hint?: string, passThreshold?: number }
export interface RunAnswer { itemId: string, value: number | null, comment?: string | null, photoMediaIds?: string[], isNa?: boolean }
export interface ActionItem { id: string, text: string, responsibleId: string, dueAt: string, status: 'open' | 'done' | 'overdue', doneAt?: string | null }

// ── Чек-листы (docs/20 §3.5, §6.1) ──────────────────────────────────────

export async function listChecklists(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.execute(sql`
      select c.*, s.name as scale_name,
             (select count(*)::int from checklist_runs r where r.checklist_id = c.id and r.status = 'finished') as runs,
             (select count(*)::int from checklist_runs r where r.checklist_id = c.id and r.status = 'finished' and r.started_at >= now() - interval '7 days') as runs_week
      from checklists c join scales s on s.id = c.scale_id order by c.is_active desc, c.updated_at desc
    `) as unknown as Promise<Record<string, unknown>[]>
  })
}

export type ChecklistSaveResult = { ok: true, checklist: typeof checklists.$inferSelect } | { ok: false, code: 'not_found' | 'locked' | 'bad_scale', fields?: string[] }

/** Замороженные поля (docs/20 §14.4): шкала, состав и веса пунктов, подсчёт, порог, критическое правило, тип, пропуск/комментарии. */
function frozenDiff(before: typeof checklists.$inferSelect, input: ChecklistInput): string[] {
  const changed: string[] = []
  const cmp: Record<string, [unknown, unknown]> = {
    kind: [before.kind, input.kind], scaleId: [before.scaleId, input.scaleId], scoring: [before.scoring, input.scoring], passScore: [Number(before.passScore), input.passScore],
    criticalFailRule: [before.criticalFailRule, input.criticalFailRule], subjectKind: [before.subjectKind, input.subjectKind], requireSignature: [before.requireSignature, input.requireSignature ?? false],
    allowSkip: [before.allowSkip, input.allowSkip], allowItemComment: [before.allowItemComment, input.allowItemComment], itemCommentRequired: [before.itemCommentRequired, input.itemCommentRequired],
  }
  for (const [k, [a, b]] of Object.entries(cmp)) if (a !== b && !(CHECKLIST_MUTABLE_WHEN_LOCKED as readonly string[]).includes(k)) changed.push(k)
  const was = before.items as ChecklistItem[]
  const norm = (i: ChecklistItem) => JSON.stringify([i.id, i.text, i.criterionId ?? null, i.weight, !!i.isCritical, !!i.requiresPhoto, i.group ?? '', i.passThreshold ?? null])
  if (was.length !== input.items.length || was.some((i, idx) => norm(i) !== norm(input.items[idx]!))) changed.push('items')
  return changed
}

export async function upsertChecklist(ctx: Ctx, input: ChecklistInput): Promise<ChecklistSaveResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const scale = await loadScale(tx, input.scaleId)
    if (!scale || !scale.options.length) return { ok: false as const, code: 'bad_scale' as const }
    const card = { title: input.title, description: input.description ?? null, instruction: input.instruction ?? [], tags: input.tags, whoCanRun: input.whoCanRun, frequency: input.frequency ?? null, isActive: input.isActive ?? true }
    const params = {
      kind: input.kind, scaleId: input.scaleId, items: input.items, scoring: input.scoring, passScore: String(input.passScore), criticalFailRule: input.criticalFailRule,
      subjectKind: input.subjectKind, requireSignature: input.requireSignature ?? false, allowSkip: input.allowSkip, allowItemComment: input.allowItemComment, itemCommentRequired: input.itemCommentRequired,
    }
    if (input.id) {
      const [before] = await tx.select().from(checklists).where(eq(checklists.id, input.id))
      if (!before) return { ok: false as const, code: 'not_found' as const }
      if (before.isLocked) {
        const changed = frozenDiff(before, input)
        if (changed.length) return { ok: false as const, code: 'locked' as const, fields: changed }
        const [r] = await tx.update(checklists).set({ ...card, updatedAt: new Date() }).where(eq(checklists.id, input.id)).returning()
        await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'checklist.update', entity: 'checklist', entityId: input.id, before: { title: before.title }, after: { title: input.title, locked: true } })
        return { ok: true as const, checklist: r! }
      }
      const [r] = await tx.update(checklists).set({ ...card, ...params, updatedAt: new Date() }).where(eq(checklists.id, input.id)).returning()
      await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'checklist.update', entity: 'checklist', entityId: input.id, before: { title: before.title, scaleId: before.scaleId, items: (before.items as unknown[]).length }, after: { title: input.title, scaleId: input.scaleId, items: input.items.length } })
      // D-019: до заморозки пункты/шкала/правила чек-листа могут меняться → баннер «N завдань змінено» у назначений
      if (frozenDiff(before, input).length) {
        const { markContentChanged } = await import('./tasks')
        await markContentChanged(tx, 'check_list', input.id)
      }
      return { ok: true as const, checklist: r! }
    }
    const [r] = await tx.insert(checklists).values({ tenantId: ctx.tenantId, createdBy: ctx.actorId, ...card, ...params }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'checklist.create', entity: 'checklist', entityId: r!.id, after: { title: input.title, items: input.items.length } })
    return { ok: true as const, checklist: r! }
  })
}

/** Заморозка при первом прогоне (docs/20 §14.4). */
async function lockChecklist(tx: TenantTx, tenantId: string, id: string, actorId: string | null) {
  const [r] = await tx.update(checklists).set({ isLocked: true, updatedAt: new Date() }).where(and(eq(checklists.id, id), eq(checklists.isLocked, false))).returning({ id: checklists.id })
  if (r) await recordAudit(tx, { tenantId, actorId, action: 'checklist.lock', entity: 'checklist', entityId: id, after: { isLocked: true } })
}

export async function getChecklist(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => getChecklistTx(tx, id))
}

// ── Прогоны (docs/20 §3.6, §5.4, §7.3–7.5) ─────────────────────────────

export async function startRun(ctx: Ctx, checklistId: string, input: { locationId?: string, subjectUserId?: string, startedAt?: string, device?: string, geo?: unknown }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.select().from(checklists).where(and(eq(checklists.id, checklistId), eq(checklists.isActive, true)))
    if (!c) return null
    const [r] = await tx.insert(checklistRuns).values({
      tenantId: ctx.tenantId, checklistId, subjectKind: c.subjectKind, locationId: input.locationId ?? null, subjectUserId: input.subjectUserId ?? null, observerId: ctx.actorId,
      startedAt: input.startedAt ? new Date(input.startedAt) : new Date(), device: input.device ?? null, geo: input.geo ?? null,
    }).returning()
    await lockChecklist(tx, ctx.tenantId, checklistId, ctx.actorId)
    return r!
  })
}

/** Автосохранение / офлайн-синхронизация: ответы и фактическое время начала (docs/20 §12). */
export async function saveRun(ctx: Ctx, runId: string, input: { answers: RunAnswer[], startedAt?: string, actionPlan?: ActionItem[] }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.update(checklistRuns).set({
      answers: input.answers, ...(input.startedAt ? { startedAt: new Date(input.startedAt) } : {}), ...(input.actionPlan ? { actionPlan: input.actionPlan } : {}), updatedAt: new Date(),
    }).where(and(eq(checklistRuns.id, runId), eq(checklistRuns.observerId, ctx.actorId), eq(checklistRuns.status, 'draft'))).returning({ id: checklistRuns.id })
    return r ?? null
  })
}

export interface RunScore { score: number, points: number, maxPoints: number, percent: number, passed: boolean, criticalFailed: string[], failedItems: string[], answered: number, total: number, missingPhoto: string[], missingComment: string[] }

export interface ScoringRules { items: ChecklistItem[], scoring: string, passScore: number, criticalFailRule: string, allowSkip?: boolean, itemCommentRequired?: boolean }

/**
 * Подсчёт (docs/20 §7.3–7.4, §14.3): «набрана частка від суми ваг» — пункт даёт (значення − min)/(max − min) × вага,
 * максимум — сумма весов отвеченных пунктов; пропущенные (n/a) вне знаменателя. Пункт «провалено», если его доля
 * ниже прохідного бала чек-листа (Spec 20 — docs/28); критический провал обнуляет результат.
 */
export function scoreRun(c: ScoringRules, answers: RunAnswer[], scale: ScaleInfo): RunScore {
  const byItem = new Map(answers.map(a => [a.itemId, a]))
  const range = Math.max(scale.max - scale.min, 1e-9)
  let points = 0, maxPoints = 0
  const criticalFailed: string[] = []
  const failedItems: string[] = []
  const missingPhoto: string[] = []
  const missingComment: string[] = []
  let answered = 0
  for (const it of c.items) {
    const a = byItem.get(it.id)
    if (!a || (a.value == null && !a.isNa)) continue
    answered++
    if (a.isNa) continue
    if (it.requiresPhoto && !(a.photoMediaIds?.length)) missingPhoto.push(it.id)
    const share = Math.min(1, Math.max(0, (Number(a.value) - scale.min) / range))
    // docs/33 D-037: свій поріг пункта, якщо заданий, інакше — прохідний бал усього чек-листа
    const ok = share * 100 >= (it.passThreshold ?? c.passScore)
    if (!ok) {
      failedItems.push(it.id)
      if (it.isCritical) criticalFailed.push(it.id)
      if (c.itemCommentRequired && !(a.comment ?? '').trim()) missingComment.push(it.id)
    }
    points += share * it.weight
    maxPoints += it.weight
  }
  points = Math.round(points * 100) / 100
  const percent = maxPoints ? Math.round((points / maxPoints) * 10000) / 100 : 0
  let score = c.scoring === 'points' ? points : percent
  let passed = c.scoring === 'points' ? points >= c.passScore : c.scoring === 'pass_fail' ? failedItems.length === 0 : percent >= c.passScore
  if (c.criticalFailRule === 'any_critical_fails_all' && criticalFailed.length) { passed = false; score = 0 }
  return { score, points, maxPoints, percent, passed, criticalFailed, failedItems, answered, total: c.items.length, missingPhoto, missingComment }
}

export type FinishResult = { ok: true, score: RunScore } | { ok: false, code: 'not_found' | 'incomplete' | 'photo_required' | 'comment_required' | 'action_plan_required' | 'signature_required', itemIds?: string[] }

/** Завершение: все пункты отвечены, фото где требуется, при провале — план действий с ответственным и сроком (docs/20 §7.5). */
export async function finishRun(ctx: Ctx, runId: string, input: { answers?: RunAnswer[], actionPlan?: ActionItem[], finishedAt?: string, startedAt?: string, signatureMediaId?: string }): Promise<FinishResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.select().from(checklistRuns).where(and(eq(checklistRuns.id, runId), eq(checklistRuns.observerId, ctx.actorId), eq(checklistRuns.status, 'draft')))
    if (!r) return { ok: false as const, code: 'not_found' as const }
    const [c] = await tx.select().from(checklists).where(eq(checklists.id, r.checklistId))
    const items = c!.items as ChecklistItem[]
    const answers = (input.answers ?? (r.answers as RunAnswer[])).map(a => c!.allowItemComment ? a : { ...a, comment: null })
    const scale = await loadScale(tx, c!.scaleId)
    if (!scale) return { ok: false as const, code: 'not_found' as const }
    const score = scoreRun({ items, scoring: c!.scoring, passScore: Number(c!.passScore), criticalFailRule: c!.criticalFailRule, allowSkip: c!.allowSkip, itemCommentRequired: c!.itemCommentRequired }, answers, scale)
    // Без «Дозволити пропускати питання» n/a не принимается — пункт считается неотвеченным
    const unanswered = items.filter(i => !answers.some(a => a.itemId === i.id && (a.value != null || (a.isNa && c!.allowSkip)))).map(i => i.id)
    if (unanswered.length) return { ok: false as const, code: 'incomplete' as const, itemIds: unanswered }
    if (score.missingPhoto.length) return { ok: false as const, code: 'photo_required' as const, itemIds: score.missingPhoto }
    if (score.missingComment.length) return { ok: false as const, code: 'comment_required' as const, itemIds: score.missingComment }
    const plan = (input.actionPlan ?? (r.actionPlan as ActionItem[])).filter(p => p.text?.trim() && p.responsibleId && p.dueAt)
    if (!score.passed && !plan.length) return { ok: false as const, code: 'action_plan_required' as const }
    // Б.1: подпись проверяемого пальцем на экране — PNG в медиа
    if (c!.requireSignature && !input.signatureMediaId && !r.signatureMediaId && !r.isExternal) return { ok: false as const, code: 'signature_required' as const }

    const finishedAt = input.finishedAt ? new Date(input.finishedAt) : new Date()
    await tx.update(checklistRuns).set({
      status: 'finished', answers, actionPlan: plan.map(p => ({ ...p, status: p.status ?? 'open' })), score: String(score.score), passed: score.passed, criticalFailed: score.criticalFailed,
      finishedAt, ...(input.startedAt ? { startedAt: new Date(input.startedAt) } : {}), signatureMediaId: input.signatureMediaId ?? r.signatureMediaId ?? null, updatedAt: new Date(),
    }).where(eq(checklistRuns.id, runId))

    // Уведомления (docs/20 §8): провал → руководителю точки сразу; критический → руководителям сети (admin)
    // v2-allow: check9 — (б) чек-лист по точке провален → руководителю точки (docs/20 §8)
    const [loc] = r.locationId ? await tx.select({ managerId: locations.managerId, name: locations.name }).from(locations).where(eq(locations.id, r.locationId)) : []
    if (!score.passed && loc?.managerId && loc.managerId !== ctx.actorId) {
      await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: loc.managerId, code: 'checklist_failed', payload: { title: c!.title, location: loc.name, score: score.score }, dedupKey: `cl_failed:${runId}` })
    }
    if (score.criticalFailed.length) {
      const admins = await tx.execute(sql`select ur.user_id from user_roles ur join roles r on r.id = ur.role_id where r.code = 'admin' and ur.scope_type = 'tenant'`) as unknown as { user_id: string }[]
      for (const a of admins) {
        if (a.user_id !== ctx.actorId) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: a.user_id, code: 'checklist_critical_failed', payload: { title: c!.title, location: loc?.name ?? '', items: score.criticalFailed.length }, dedupKey: `cl_crit:${runId}:${a.user_id}` })
      }
    }
    for (const p of plan) {
      if (p.responsibleId !== ctx.actorId) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: p.responsibleId, code: 'action_item_due', payload: { text: p.text, due: p.dueAt, title: c!.title }, dedupKey: `ai_new:${runId}:${p.id}` })
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'checklist.run.finish', entity: 'checklist_run', entityId: runId, after: { score: score.score, passed: score.passed } })
    // docs/33 D-020: чек-лист заповнено — завдання спостерігача виконане (результат — відсоток прогону; провал точки — не провал завдання)
    const { onTaskCompleted } = await import('./taskCompletion')
    await onTaskCompleted(tx, ctx.tenantId, ctx.actorId, { contentType: 'check_list', contentId: r.checklistId, status: 'done', result: score.score, sourceKind: 'checklist_run', sourceId: runId })
    // Лента того, кто заполнил чек-лист (docs/v2/38 §7.9), — днём заполнения: прогон, досланный
    // из офлайна, несёт своё `finishedAt` (Р-34.3)
    await recordActivity(tx, ctx.tenantId, { userId: ctx.actorId, kind: 'checklist_run_completed', ref: { entity: 'checklist_runs', id: runId }, occurredAt: finishedAt })
    return { ok: true as const, score }
  })
}

export async function getRun(ctx: Ctx, runId: string, opts: { canSeeUnpublished?: boolean } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.select().from(checklistRuns).where(eq(checklistRuns.id, runId))
    if (!r) return null
    if (r.waveId && !opts.canSeeUnpublished) {
      const [w] = await tx.execute(sql`select status from mystery_waves where id = ${r.waveId}::uuid`) as unknown as { status: string }[]
      if (w?.status !== 'published') return null
    }
    const c = await getChecklistTx(tx, r.checklistId)
    const [observer] = await tx.select({ fullName: users.fullName }).from(users).where(eq(users.id, r.observerId))
    const [loc] = r.locationId ? await tx.select({ name: locations.name }).from(locations).where(eq(locations.id, r.locationId)) : []
    const [subject] = r.subjectUserId ? await tx.select({ fullName: users.fullName }).from(users).where(eq(users.id, r.subjectUserId)) : []
    const plan = r.actionPlan as ActionItem[]
    const respIds = [...new Set(plan.map(p => p.responsibleId))]
    const resp = respIds.length ? await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, respIds)) : []
    return { ...r, checklist: c, observerName: observer?.fullName, locationName: loc?.name ?? null, subjectName: subject?.fullName ?? null, responsibles: Object.fromEntries(resp.map(u => [u.id, u.fullName])) }
  })
}

async function getChecklistTx(tx: TenantTx, id: string) {
  const [c] = await tx.select().from(checklists).where(eq(checklists.id, id))
  if (!c) return null
  const scale = await loadScale(tx, c.scaleId)
  return { ...c, scale, maxPoints: (c.items as ChecklistItem[]).reduce((acc, i) => acc + i.weight, 0) }
}

export async function myRuns(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.execute(sql`
      select r.id, r.status, r.started_at, r.finished_at, r.score, r.passed, c.title, l.name as location
      from checklist_runs r join checklists c on c.id = r.checklist_id left join locations l on l.id = r.location_id
      where r.observer_id = ${ctx.actorId}::uuid order by r.started_at desc limit 100
    `) as unknown as Promise<Record<string, unknown>[]>
  })
}

/** Пункты плана действий: статус open → done; overdue ставит сканер. */
export async function updateAction(ctx: Ctx, runId: string, actionId: string, patch: { status?: 'open' | 'done', text?: string, dueAt?: string, responsibleId?: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.select().from(checklistRuns).where(eq(checklistRuns.id, runId))
    if (!r) return null
    const plan = (r.actionPlan as ActionItem[]).map(p => p.id === actionId ? { ...p, ...patch, doneAt: patch.status === 'done' ? new Date().toISOString() : patch.status === 'open' ? null : p.doneAt } : p)
    await tx.update(checklistRuns).set({ actionPlan: plan, updatedAt: new Date() }).where(eq(checklistRuns.id, runId))
    return plan.find(p => p.id === actionId) ?? null
  })
}

export async function addAction(ctx: Ctx, runId: string, item: { text: string, responsibleId: string, dueAt: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.select().from(checklistRuns).where(eq(checklistRuns.id, runId))
    if (!r) return null
    const a: ActionItem = { id: crypto.randomUUID(), ...item, status: 'open' }
    await tx.update(checklistRuns).set({ actionPlan: [...(r.actionPlan as ActionItem[]), a], updatedAt: new Date() }).where(eq(checklistRuns.id, runId))
    if (item.responsibleId !== ctx.actorId) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: item.responsibleId, code: 'action_item_due', payload: { text: item.text, due: item.dueAt }, dedupKey: `ai_new:${runId}:${a.id}` })
    return a
  })
}

// ── Отчёты (docs/20 §9) ─────────────────────────────────────────────────

export interface ChecklistReportFilter { from?: string, to?: string, locationId?: string, checklistId?: string, scope?: string[] | null, canSeeUnpublished?: boolean }

/** Общее условие выборки прогонов для всех разрезов отчёта чек-листів (докс/31 ChecklistReport). */
function checklistRunsWhere(filter: ChecklistReportFilter): SQL {
  // Прогоны тайного покупателя до публикации волны видит только руководство сети (docs/20 §7.8)
  return sql`r.status = 'finished'
    ${filter.canSeeUnpublished ? sql`` : sql`and (r.wave_id is null or exists (select 1 from mystery_waves w where w.id = r.wave_id and w.status = 'published'))`}
    ${filter.from ? sql`and r.started_at >= ${filter.from}::date` : sql``}
    ${filter.to ? sql`and r.started_at < (${filter.to}::date + 1)` : sql``}
    ${scopeSql(filter.scope ?? null, sql`r.location_id`)}
    ${filter.checklistId ? sql`and r.checklist_id = ${filter.checklistId}::uuid` : sql``}`
}

export async function checklistReport(ctx: Ctx, filter: ChecklistReportFilter = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const where = checklistRunsWhere(filter)
    const runs = await tx.execute(sql`
      select r.id, r.started_at, r.finished_at, r.score, r.passed, r.critical_failed, r.action_plan, c.title, c.kind, l.name as location, u.full_name as observer
      from checklist_runs r join checklists c on c.id = r.checklist_id left join locations l on l.id = r.location_id join users u on u.id = r.observer_id
      where ${where} order by r.started_at desc limit 500
    `) as unknown as Record<string, unknown>[]
    const byLocationWeek = await tx.execute(sql`
      select l.name as location, date_trunc('week', r.started_at)::date as week, round(avg(r.score), 1) as avg_score, count(*)::int as runs
      from checklist_runs r left join locations l on l.id = r.location_id where ${where}
      group by 1, 2 order by 2 desc, 1 limit 200
    `) as unknown as Record<string, unknown>[]
    // Топ проваливаемых пунктов
    const topFailed = await tx.execute(sql`
      with a as (
        select r.checklist_id, (x->>'itemId') as item_id, (x->>'value')::numeric as value, (x->>'isNa')::boolean as is_na
        from checklist_runs r cross join jsonb_array_elements(r.answers) x where ${where}
      ), it as (
        -- Провал пункта: доля (значення − min)/(max − min) ниже свого порога пункта (docs/33 D-037),
        -- при его отсутствии — ниже прохідного бала чек-листа (та же формула, что в scoreRun)
        select c.id as checklist_id, c.title, (i->>'id') as item_id, (i->>'text') as text, coalesce((i->>'passThreshold')::numeric, c.pass_score) as threshold,
               (select min(value) from scale_levels sl where sl.scale_id = c.scale_id) as smin,
               (select max(value) from scale_levels sl where sl.scale_id = c.scale_id) as smax
        from checklists c cross join jsonb_array_elements(c.items) i
      )
      select it.title as checklist, it.text, count(*)::int as total,
             sum(case when (a.value - it.smin) / greatest(it.smax - it.smin, 0.000001) * 100 < it.threshold then 1 else 0 end)::int as failed
      from a join it on it.checklist_id = a.checklist_id and it.item_id = a.item_id
      where a.is_na is not true and a.value is not null
      group by 1, 2 having sum(case when (a.value - it.smin) / greatest(it.smax - it.smin, 0.000001) * 100 < it.threshold then 1 else 0 end) > 0 order by failed desc limit 20
    `) as unknown as Record<string, unknown>[]
    const actions = runs.flatMap(r => (r.action_plan as ActionItem[]).map(p => ({ ...p, runId: r.id, location: r.location, checklist: r.title })))
    return { runs, byLocationWeek, topFailed, actions: { total: actions.length, done: actions.filter(a => a.status === 'done').length, overdue: actions.filter(a => a.status === 'overdue').length } }
  })
}

/**
 * Розріз «По пунктах» (докс/31 ChecklistReport, мокап): ПУНКТ · ВАГА · ВИКОНАНО · ЧАСТКА —
 * по кожному пункту серед усіх чек-листів під фільтром скільки разів пункт зараховано (доля
 * (значення − min)/(max − min) не нижче порога пункта — та ж формула, що в `scoreRun`/`topFailed`,
 * тільки лічимо виконані, а не провалені, і не ховаємо пункти без провалів).
 */
export async function checklistItemsReport(ctx: Ctx, filter: ChecklistReportFilter = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const where = checklistRunsWhere(filter)
    return tx.execute(sql`
      with a as (
        select r.checklist_id, (x->>'itemId') as item_id, (x->>'value')::numeric as value, (x->>'isNa')::boolean as is_na
        from checklist_runs r cross join jsonb_array_elements(r.answers) x where ${where}
      ), it as (
        select c.id as checklist_id, c.title, (i->>'id') as item_id, (i->>'text') as text, ((i->>'weight')::float8) as weight,
               coalesce((i->>'passThreshold')::numeric, c.pass_score) as threshold,
               (select min(value) from scale_levels sl where sl.scale_id = c.scale_id) as smin,
               (select max(value) from scale_levels sl where sl.scale_id = c.scale_id) as smax
        from checklists c cross join jsonb_array_elements(c.items) i
        where ${filter.checklistId ? sql`c.id = ${filter.checklistId}::uuid` : sql`true`}
      )
      select it.title as checklist, it.text, it.weight, count(*)::int as total,
             sum(case when (a.value - it.smin) / greatest(it.smax - it.smin, 0.000001) * 100 >= it.threshold then 1 else 0 end)::int as done,
             round(sum(case when (a.value - it.smin) / greatest(it.smax - it.smin, 0.000001) * 100 >= it.threshold then 1 else 0 end)::numeric / count(*) * 100, 1) as share
      from a join it on it.checklist_id = a.checklist_id and it.item_id = a.item_id
      where a.is_na is not true and a.value is not null
      group by it.title, it.text, it.weight
      order by share asc, it.title, it.text limit 200
    `) as unknown as Promise<{ checklist: string, text: string, weight: number, total: number, done: number, share: string }[]>
  })
}

/** Розріз «По точках» (докс/31 ChecklistReport): точка · прогонів · середній %. */
export async function checklistLocationsReport(ctx: Ctx, filter: ChecklistReportFilter = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const where = checklistRunsWhere(filter)
    return tx.execute(sql`
      select l.id as location_id, l.name as location, count(*)::int as runs, round(avg(r.score), 1) as avg_score,
             sum(case when r.passed then 1 else 0 end)::int as passed
      from checklist_runs r join locations l on l.id = r.location_id
      where ${where}
      group by l.id, l.name
      order by avg_score asc nulls last, l.name limit 200
    `) as unknown as Promise<{ location_id: string, location: string, runs: number, avg_score: string | null, passed: number }[]>
  })
}

/**
 * Розріз «По людях» (докс/31 ChecklistReport): хто проводив перевірки — єдиний каркас
 * `reportFrame` (докс/22 §13.3) плюс кількість прогонів і середній результат у «результаті».
 */
export async function checklistPeopleReport(ctx: Ctx, filter: ChecklistReportFilter = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const where = checklistRunsWhere(filter)
    return tx.execute(sql`
      select ${frameSelect()},
             ${frameTail({ assignedAt: sql`min(r.started_at)`, completedAt: sql`max(r.finished_at)`, status: sql`'done'`, result: sql`round(avg(r.score), 1)` })},
             count(*)::int as runs
      from checklist_runs r
      join users u on u.id = r.observer_id
      ${frameJoins()}
      where ${where}
      group by u.id, u.full_name, u.status, p.name, ci.name, ou.name, l.name, u.tags
      order by result asc nulls last, full_name limit 500
    `) as unknown as Promise<Record<string, unknown>[]>
  })
}

/** Дисциплина проверок (docs/20 §9): сколько раз чек-лист с частотой проведён на точке за неделю против нормы. */
export async function disciplineReport(ctx: Ctx, scope: string[] | null = null) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.execute(sql`
      select * from (
        select c.title as checklist, l.id as location_id, l.name as location, (c.frequency->>'timesPerWeek')::int as norm,
               (select count(*)::int from checklist_runs r where r.checklist_id = c.id and r.location_id = l.id and r.status = 'finished' and r.started_at >= date_trunc('week', now())) as done
        from checklists c cross join locations l
        where c.is_active and c.frequency is not null and c.subject_kind = 'location' ${scopeSql(scope, sql`l.id`)}
      ) x order by (done < norm) desc, location, checklist
    `) as unknown as Promise<{ checklist: string, location_id: string, location: string, norm: number, done: number }[]>
  })
}

/** Еженедельно (docs/20 §7.7): точки без положенного числа прогонов → напоминание руководителю. */
export async function frequencyScan(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`
      -- v2-allow: check9 — (б) точка не выполнила норму прогонов → руководителю точки
      select c.title, l.name as location, l.manager_id, (c.frequency->>'timesPerWeek')::int as norm,
             (select count(*)::int from checklist_runs r where r.checklist_id = c.id and r.location_id = l.id and r.status = 'finished' and r.started_at >= now() - interval '7 days') as done
      from checklists c cross join locations l
      -- v2-allow: check9 — (б) то же, условие выборки
      where c.is_active and c.frequency is not null and c.subject_kind = 'location' and l.manager_id is not null
    `) as unknown as { title: string, location: string, manager_id: string, norm: number, done: number }[] // v2-allow: check9 — (б) то же, тип строки
    const week = new Date().toISOString().slice(0, 10)
    let n = 0
    for (const r of rows.filter(r => r.done < r.norm)) {
      if (await enqueueNotification(tx, { tenantId, userId: r.manager_id, code: 'checklist_due', payload: { title: r.title, location: r.location, done: r.done, norm: r.norm }, dedupKey: `cl_due:${r.title}:${r.location}:${week}` })) n++
    }
    return n
  })
}

/** Ежедневно: пункты плана действий с истёкшим сроком → overdue + уведомление ответственному. */
export async function actionDueScan(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const runs = await tx.select({ id: checklistRuns.id, actionPlan: checklistRuns.actionPlan }).from(checklistRuns)
      .where(and(eq(checklistRuns.status, 'finished'), sql`exists (select 1 from jsonb_array_elements(${checklistRuns.actionPlan}) p where p->>'status' = 'open' and (p->>'dueAt')::date < current_date)`))
    let n = 0
    const today = new Date().toISOString().slice(0, 10)
    for (const r of runs) {
      const plan = (r.actionPlan as ActionItem[]).map((p) => {
        if (p.status === 'open' && p.dueAt < today) { n++; return { ...p, status: 'overdue' as const } }
        return p
      })
      await tx.update(checklistRuns).set({ actionPlan: plan, updatedAt: new Date() }).where(eq(checklistRuns.id, r.id))
      for (const p of plan.filter(p => p.status === 'overdue')) {
        await enqueueNotification(tx, { tenantId, userId: p.responsibleId, code: 'action_item_overdue', payload: { text: p.text, due: p.dueAt }, dedupKey: `ai_overdue:${r.id}:${p.id}` })
      }
    }
    return n
  })
}

export async function assessmentReport(ctx: Ctx, filter: { cycleId?: string, locationId?: string, scope?: string[] | null } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    // Каркас docs/22 §13.3 + колонки Г-20.3: Кого оцінюють · Роль оцінювача · Заповнено · Дата заповнення ·
    // Середній бал · Бал по групах критеріїв · Розрив із нормою (факт − норма по каждому критерию)
    return tx.execute(sql`
      select ${frameSelect()}, c.id as cycle_id, c.title as cycle, t.id as task_id, t.rater_kind,
             ${frameTail({ assignedAt: sql`t.created_at`, completedAt: sql`t.submitted_at`, status: sql`case when t.status = 'submitted' then 'done' when t.status = 'in_progress' then 'in_progress' when t.status in ('declined', 'expired') then 'failed' else 'not_started' end`, result: sql`av.avg_score` })},
             (t.status = 'submitted') as filled, av.avg_score, gr.by_group, gp.gaps
      from assessment_tasks t
      join assessment_cycles c on c.id = t.cycle_id
      join assessment_forms f on f.id = c.form_id
      join users u on u.id = t.subject_user_id
      ${frameJoins()}
      left join lateral (
        select round(avg(a.value), 2) as avg_score from assessment_answers a
        where a.task_id = t.id and a.is_na = false and a.value is not null and not (f.zero_means_no_grade and a.value = 0)
      ) av on true
      left join lateral (
        select jsonb_object_agg(x.name, x.v) as by_group from (
          select cg.name, round(avg(a.value), 2) as v from assessment_answers a
          join criteria cr on cr.id = a.criterion_id join criteria_groups cg on cg.id = cr.group_id
          where a.task_id = t.id and a.is_na = false and a.value is not null and not (f.zero_means_no_grade and a.value = 0) group by cg.name) x
      ) gr on true
      left join lateral (
        select jsonb_agg(jsonb_build_object('criterion', cr.text, 'value', a.value, 'norm', ai.norm, 'gap', round(a.value - ai.norm, 2)) order by ai.sort_order) as gaps
        from assessment_answers a join criteria cr on cr.id = a.criterion_id
        join assessment_items ai on ai.criterion_id = a.criterion_id and ai.form_id = c.form_id
        where a.task_id = t.id and a.is_na = false and a.value is not null and not (f.zero_means_no_grade and a.value = 0)
      ) gp on true
      where true ${scopeSql(filter.scope ?? null, sql`pl.location_id`)}
        ${filter.cycleId ? sql`and t.cycle_id = ${filter.cycleId}::uuid` : sql``}
        ${filter.locationId ? sql`and pl.location_id = ${filter.locationId}::uuid` : sql``}
      order by c.created_at desc, u.full_name, t.rater_kind limit 1000
    `) as unknown as Promise<Record<string, unknown>[]>
  })
}
