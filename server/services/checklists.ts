import { and, eq, inArray, sql } from 'drizzle-orm'
import { checklistRuns, checklists, locations, ratingScales, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { scopeSql } from './access'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import type { ScaleOption } from './assessment'

interface Ctx { tenantId: string, actorId: string }

export interface ChecklistItem { id: string, group?: string, text: string, scaleId: string, weight: number, isCritical?: boolean, requiresPhoto?: boolean, hint?: string }
export interface RunAnswer { itemId: string, value: number | null, comment?: string | null, photoMediaIds?: string[], isNa?: boolean }
export interface ActionItem { id: string, text: string, responsibleId: string, dueAt: string, status: 'open' | 'done' | 'overdue', doneAt?: string | null }

// ── Чек-листы (docs/20 §3.5, §6.1) ──────────────────────────────────────

export async function listChecklists(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.execute(sql`
      select c.*, (select count(*)::int from checklist_runs r where r.checklist_id = c.id and r.status = 'finished') as runs,
             (select count(*)::int from checklist_runs r where r.checklist_id = c.id and r.status = 'finished' and r.started_at >= now() - interval '7 days') as runs_week
      from checklists c order by c.is_active desc, c.title
    `) as unknown as Promise<Record<string, unknown>[]>
  })
}

export async function upsertChecklist(ctx: Ctx, input: { id?: string, title: string, kind: string, items: ChecklistItem[], scoring: string, passScore: number, criticalFailRule: string, whoCanRun: unknown, subjectKind: string, frequency?: { timesPerWeek: number } | null, requireSignature?: boolean, isActive?: boolean }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const values = {
      title: input.title, kind: input.kind, items: input.items, scoring: input.scoring, passScore: String(input.passScore), criticalFailRule: input.criticalFailRule,
      whoCanRun: input.whoCanRun ?? { roles: ['mentor', 'manager', 'admin'] }, subjectKind: input.subjectKind, frequency: input.frequency ?? null, requireSignature: input.requireSignature ?? false, isActive: input.isActive ?? true,
    }
    if (input.id) {
      const [r] = await tx.update(checklists).set({ ...values, updatedAt: new Date() }).where(eq(checklists.id, input.id)).returning()
      return r ?? null
    }
    const [r] = await tx.insert(checklists).values({ tenantId: ctx.tenantId, createdBy: ctx.actorId, ...values }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'checklist.create', entity: 'checklist', entityId: r!.id })
    return r!
  })
}

export async function getChecklist(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.select().from(checklists).where(eq(checklists.id, id))
    if (!c) return null
    const items = c.items as ChecklistItem[]
    const scaleIds = [...new Set(items.map(i => i.scaleId))]
    const scales = scaleIds.length ? await tx.select().from(ratingScales).where(inArray(ratingScales.id, scaleIds)) : []
    return { ...c, scales }
  })
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

export interface RunScore { score: number, passed: boolean, criticalFailed: string[], failedItems: string[], answered: number, total: number, missingPhoto: string[] }

/** Подсчёт (docs/20 §7.3–7.4): percent/points по весам, n/a вне знаменателя; критический провал обнуляет. */
export function scoreRun(c: { items: ChecklistItem[], scoring: string, passScore: number, criticalFailRule: string }, answers: RunAnswer[], scales: Map<string, { options: ScaleOption[], passThreshold: number | null }>): RunScore {
  const byItem = new Map(answers.map(a => [a.itemId, a]))
  let num = 0, den = 0, maxPts = 0
  const criticalFailed: string[] = []
  const failedItems: string[] = []
  const missingPhoto: string[] = []
  let answered = 0
  for (const it of c.items) {
    const a = byItem.get(it.id)
    const scale = scales.get(it.scaleId)
    const max = Math.max(...(scale?.options ?? [{ value: 1 }]).map(o => o.value), 1)
    const pass = scale?.passThreshold ?? max
    maxPts += it.weight * max
    if (!a || (a.value == null && !a.isNa)) continue
    answered++
    if (a.isNa) continue
    if (it.requiresPhoto && !(a.photoMediaIds?.length)) missingPhoto.push(it.id)
    const ok = Number(a.value) >= pass
    if (!ok) { failedItems.push(it.id); if (it.isCritical) criticalFailed.push(it.id) }
    num += Number(a.value) * it.weight
    den += max * it.weight
  }
  let score = c.scoring === 'points' ? Math.round(num * 100) / 100 : den ? Math.round((num / den) * 10000) / 100 : 0
  let passed = c.scoring === 'points' ? score >= c.passScore : c.scoring === 'pass_fail' ? failedItems.length === 0 : score >= c.passScore
  if (c.criticalFailRule === 'any_critical_fails_all' && criticalFailed.length) { passed = false; score = 0 }
  void maxPts
  return { score, passed, criticalFailed, failedItems, answered, total: c.items.length, missingPhoto }
}

export type FinishResult = { ok: true, score: RunScore } | { ok: false, code: 'not_found' | 'incomplete' | 'photo_required' | 'action_plan_required' | 'signature_required', itemIds?: string[] }

/** Завершение: все пункты отвечены, фото где требуется, при провале — план действий с ответственным и сроком (docs/20 §7.5). */
export async function finishRun(ctx: Ctx, runId: string, input: { answers?: RunAnswer[], actionPlan?: ActionItem[], finishedAt?: string, startedAt?: string, signatureMediaId?: string }): Promise<FinishResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.select().from(checklistRuns).where(and(eq(checklistRuns.id, runId), eq(checklistRuns.observerId, ctx.actorId), eq(checklistRuns.status, 'draft')))
    if (!r) return { ok: false as const, code: 'not_found' as const }
    const [c] = await tx.select().from(checklists).where(eq(checklists.id, r.checklistId))
    const items = c!.items as ChecklistItem[]
    const answers = input.answers ?? (r.answers as RunAnswer[])
    const scaleRows = await tx.select().from(ratingScales).where(inArray(ratingScales.id, [...new Set(items.map(i => i.scaleId))]))
    const scales = new Map(scaleRows.map(s => [s.id, { options: s.options as ScaleOption[], passThreshold: s.passThreshold != null ? Number(s.passThreshold) : null }]))
    const score = scoreRun({ items, scoring: c!.scoring, passScore: Number(c!.passScore), criticalFailRule: c!.criticalFailRule }, answers, scales)
    if (score.answered < score.total) return { ok: false as const, code: 'incomplete' as const, itemIds: items.filter(i => !answers.some(a => a.itemId === i.id && (a.value != null || a.isNa))).map(i => i.id) }
    if (score.missingPhoto.length) return { ok: false as const, code: 'photo_required' as const, itemIds: score.missingPhoto }
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
  const items = c.items as ChecklistItem[]
  const scaleIds = [...new Set(items.map(i => i.scaleId))]
  const scales = scaleIds.length ? await tx.select().from(ratingScales).where(inArray(ratingScales.id, scaleIds)) : []
  return { ...c, scales }
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

export async function checklistReport(ctx: Ctx, filter: { from?: string, to?: string, locationId?: string, checklistId?: string, scope?: string[] | null, canSeeUnpublished?: boolean } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    // Прогоны тайного покупателя до публикации волны видит только руководство сети (docs/20 §7.8)
    const where = sql`r.status = 'finished'
      ${filter.canSeeUnpublished ? sql`` : sql`and (r.wave_id is null or exists (select 1 from mystery_waves w where w.id = r.wave_id and w.status = 'published'))`}
      ${filter.from ? sql`and r.started_at >= ${filter.from}::date` : sql``}
      ${filter.to ? sql`and r.started_at < (${filter.to}::date + 1)` : sql``}
      ${scopeSql(filter.scope ?? null, sql`r.location_id`)}
      ${filter.checklistId ? sql`and r.checklist_id = ${filter.checklistId}::uuid` : sql``}`
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
        select c.id as checklist_id, c.title, (i->>'id') as item_id, (i->>'text') as text, (i->>'scaleId')::uuid as scale_id
        from checklists c cross join jsonb_array_elements(c.items) i
      )
      select it.title as checklist, it.text, count(*)::int as total,
             sum(case when a.value < coalesce(s.pass_threshold, 1) then 1 else 0 end)::int as failed
      from a join it on it.checklist_id = a.checklist_id and it.item_id = a.item_id left join rating_scales s on s.id = it.scale_id
      where a.is_na is not true and a.value is not null
      group by 1, 2 having sum(case when a.value < coalesce(s.pass_threshold, 1) then 1 else 0 end) > 0 order by failed desc limit 20
    `) as unknown as Record<string, unknown>[]
    const actions = runs.flatMap(r => (r.action_plan as ActionItem[]).map(p => ({ ...p, runId: r.id, location: r.location, checklist: r.title })))
    return { runs, byLocationWeek, topFailed, actions: { total: actions.length, done: actions.filter(a => a.status === 'done').length, overdue: actions.filter(a => a.status === 'overdue').length } }
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
      select c.title, l.name as location, l.manager_id, (c.frequency->>'timesPerWeek')::int as norm,
             (select count(*)::int from checklist_runs r where r.checklist_id = c.id and r.location_id = l.id and r.status = 'finished' and r.started_at >= now() - interval '7 days') as done
      from checklists c cross join locations l
      where c.is_active and c.frequency is not null and c.subject_kind = 'location' and l.manager_id is not null
    `) as unknown as { title: string, location: string, manager_id: string, norm: number, done: number }[]
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
    // По человеку: средние self/manager/peer и расхождение self−manager по анкете в целом
    return tx.execute(sql`
      with sub as (
        select t.cycle_id, t.subject_user_id, t.rater_kind, avg(a.value) as avg_value
        from assessment_tasks t join assessment_answers a on a.task_id = t.id
        join assessment_cycles c on c.id = t.cycle_id
        where t.status = 'submitted' and a.is_na = false and a.value is not null
          ${filter.cycleId ? sql`and t.cycle_id = ${filter.cycleId}::uuid` : sql``}
        group by 1, 2, 3
      )
      select c.title as cycle, u.full_name, l.name as location,
             round(max(case when s.rater_kind = 'self' then s.avg_value end), 2) as self,
             round(max(case when s.rater_kind = 'manager' then s.avg_value end), 2) as manager,
             round(max(case when s.rater_kind = 'peer' then s.avg_value end), 2) as peer,
             round(max(case when s.rater_kind = 'self' then s.avg_value end) - max(case when s.rater_kind = 'manager' then s.avg_value end), 2) as gap
      from sub s join users u on u.id = s.subject_user_id join assessment_cycles c on c.id = s.cycle_id
      left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null left join locations l on l.id = up.location_id
      where true ${scopeSql(filter.scope ?? null, sql`up.location_id`)}
      group by 1, 2, 3 order by 1, 2 limit 500
    `) as unknown as Promise<Record<string, unknown>[]>
  })
}
