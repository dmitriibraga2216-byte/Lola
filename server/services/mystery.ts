import { createHash, randomBytes } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { checklistRuns, checklists, locations, mysteryLinks, mysteryWaves } from '../db/schema'
import { db } from '../db/client'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { scoreRun } from './checklists'
import type { ActionItem, ChecklistItem, RunAnswer } from './checklists'
import { loadScale } from './assessment'
import { scopeSql } from './access'

interface Ctx { tenantId: string, actorId: string }
const hash = (t: string) => createHash('sha256').update(t).digest('hex')

/**
 * Тайный покупатель (docs/20 §7.8, §9; решение Б.2): волна → одноразовые ссылки на точки (24 часа, без входа) →
 * прогон чек-листа `kind=mystery` от имени выдавшего ссылку, `is_external=true`; результаты видны только
 * `report.tenant` до публикации волны; отчёт — волны × точки, динамика.
 */

export async function listWaves(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => tx.execute(sql`
    select w.*, c.title as checklist_title,
           (select count(*)::int from mystery_links l where l.wave_id = w.id) as links,
           (select count(*)::int from mystery_links l where l.wave_id = w.id and l.run_id is not null) as done,
           (select round(avg(r.score), 1) from checklist_runs r where r.wave_id = w.id and r.status = 'finished') as avg_score
    from mystery_waves w join checklists c on c.id = w.checklist_id order by w.starts_at desc
  `) as unknown as Promise<Record<string, unknown>[]>)
}

export async function createWave(ctx: Ctx, input: { checklistId: string, title: string, startsAt: string, endsAt: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.select({ id: checklists.id, kind: checklists.kind }).from(checklists).where(eq(checklists.id, input.checklistId))
    if (!c || c.kind !== 'mystery') return null
    const [w] = await tx.insert(mysteryWaves).values({ tenantId: ctx.tenantId, checklistId: input.checklistId, title: input.title, startsAt: input.startsAt, endsAt: input.endsAt, createdBy: ctx.actorId }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'mystery.wave.create', entity: 'mystery_wave', entityId: w!.id, after: { title: input.title } })
    return w!
  })
}

/** Публикация: результаты волны становятся видны руководителям точек (docs/20 §7.8). */
export async function setWaveStatus(ctx: Ctx, id: string, status: 'active' | 'published' | 'closed') {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [w] = await tx.update(mysteryWaves).set({ status, ...(status === 'published' ? { publishedAt: new Date() } : {}), updatedAt: new Date() }).where(eq(mysteryWaves.id, id)).returning()
    if (w) await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'mystery.wave.status', entity: 'mystery_wave', entityId: id, after: { status } })
    return w ?? null
  })
}

/** Одноразовая ссылка на точку: токен отдаётся один раз, хранится хэш; живёт 24 часа. */
export async function createLink(ctx: Ctx, input: { waveId: string, locationId: string }): Promise<{ token: string, expiresAt: Date, id: string } | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [w] = await tx.select().from(mysteryWaves).where(and(eq(mysteryWaves.id, input.waveId), eq(mysteryWaves.status, 'active')))
    if (!w) return null
    const token = randomBytes(24).toString('base64url')
    const expiresAt = new Date(Date.now() + 24 * 3_600_000)
    const [l] = await tx.insert(mysteryLinks).values({ tenantId: ctx.tenantId, waveId: input.waveId, locationId: input.locationId, tokenHash: hash(token), expiresAt, createdBy: ctx.actorId }).returning({ id: mysteryLinks.id })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'mystery.link.create', entity: 'mystery_link', entityId: l!.id, after: { waveId: input.waveId, locationId: input.locationId } })
    return { token, expiresAt, id: l!.id }
  })
}

export async function listLinks(ctx: Ctx, waveId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => tx.execute(sql`
    select l.id, l.location_id, loc.name as location, l.expires_at, l.used_at, l.run_id, r.score, r.passed
    from mystery_links l join locations loc on loc.id = l.location_id left join checklist_runs r on r.id = l.run_id
    where l.wave_id = ${waveId}::uuid order by loc.name, l.created_at desc
  `) as unknown as Promise<Record<string, unknown>[]>)
}

// ── Публичная часть (без сессии) ──────────────────────────────────────

interface LinkRow { id: string, tenant_id: string, wave_id: string, location_id: string, expires_at: string, used_at: string | null, run_id: string | null, created_by: string }
export type LinkState = { ok: true, link: LinkRow } | { ok: false, code: 'not_found' | 'expired' | 'used' }

export async function resolveLink(token: string): Promise<LinkState> {
  const rows = await db.execute(sql`select * from mystery_link_lookup(${hash(token)})`) as unknown as LinkRow[]
  const l = rows[0]
  if (!l) return { ok: false, code: 'not_found' }
  if (l.used_at) return { ok: false, code: 'used' }
  if (new Date(l.expires_at) < new Date()) return { ok: false, code: 'expired' }
  return { ok: true, link: l }
}

/** Форма для тайного покупателя: чек-лист, шкалы, точка — без имён сотрудников. */
export async function publicForm(token: string) {
  const st = await resolveLink(token)
  if (!st.ok) return st
  const l = st.link
  return withTenant(l.tenant_id, l.created_by, async (tx) => {
    const [w] = await tx.select().from(mysteryWaves).where(eq(mysteryWaves.id, l.wave_id))
    if (!w || w.status !== 'active') return { ok: false as const, code: 'expired' as const }
    const [c] = await tx.select({ id: checklists.id, title: checklists.title, items: checklists.items, scaleId: checklists.scaleId, allowSkip: checklists.allowSkip, allowItemComment: checklists.allowItemComment, requireSignature: checklists.requireSignature }).from(checklists).where(eq(checklists.id, w.checklistId))
    if (!c) return { ok: false as const, code: 'not_found' as const }
    const [loc] = await tx.select({ name: locations.name, address: locations.address }).from(locations).where(eq(locations.id, l.location_id))
    const items = c.items as ChecklistItem[]
    const scale = await loadScale(tx, c.scaleId)
    return { ok: true as const, form: { wave: w.title, checklist: { id: c.id, title: c.title, items, allowSkip: c.allowSkip, allowItemComment: c.allowItemComment }, scale, location: loc ?? null, expiresAt: l.expires_at } }
  })
}

/** Отправка: создаёт завершённый прогон от имени выдавшего ссылку, помечает ссылку использованной. */
export async function publicSubmit(token: string, input: { answers: RunAnswer[], startedAt?: string, device?: string }): Promise<{ ok: true, score: number, passed: boolean } | { ok: false, code: 'not_found' | 'expired' | 'used' | 'incomplete', itemIds?: string[] }> {
  const st = await resolveLink(token)
  if (!st.ok) return st
  const l = st.link
  return withTenant(l.tenant_id, l.created_by, async (tx) => {
    const [w] = await tx.select().from(mysteryWaves).where(eq(mysteryWaves.id, l.wave_id))
    if (!w || w.status !== 'active') return { ok: false as const, code: 'expired' as const }
    const [c] = await tx.select().from(checklists).where(eq(checklists.id, w.checklistId))
    if (!c) return { ok: false as const, code: 'not_found' as const }
    const items = c.items as ChecklistItem[]
    const scale = await loadScale(tx, c.scaleId)
    if (!scale) return { ok: false as const, code: 'not_found' as const }
    const score = scoreRun({ items, scoring: c.scoring, passScore: Number(c.passScore), criticalFailRule: c.criticalFailRule, allowSkip: c.allowSkip }, input.answers, scale)
    const unanswered = items.filter(i => !input.answers.some(a => a.itemId === i.id && (a.value != null || (a.isNa && c.allowSkip)))).map(i => i.id)
    if (unanswered.length) return { ok: false as const, code: 'incomplete' as const, itemIds: unanswered }
    const plan: ActionItem[] = []
    const [r] = await tx.insert(checklistRuns).values({
      tenantId: l.tenant_id, checklistId: c.id, subjectKind: 'location', locationId: l.location_id, observerId: l.created_by, status: 'finished',
      startedAt: input.startedAt ? new Date(input.startedAt) : new Date(), finishedAt: new Date(), answers: input.answers, score: String(score.score), passed: score.passed,
      criticalFailed: score.criticalFailed, actionPlan: plan, device: input.device ?? null, waveId: l.wave_id, isExternal: true,
    }).returning({ id: checklistRuns.id })
    await tx.update(mysteryLinks).set({ usedAt: new Date(), runId: r!.id, updatedAt: new Date() }).where(eq(mysteryLinks.id, l.id))
    await recordAudit(tx, { tenantId: l.tenant_id, actorId: null, action: 'mystery.run.submit', entity: 'checklist_run', entityId: r!.id, after: { waveId: l.wave_id, locationId: l.location_id, score: score.score } })
    return { ok: true as const, score: score.score, passed: score.passed }
  })
}

// ── Отчёт (docs/20 §9): волны × точки, динамика, сравнение ────────────

export async function mysteryReport(ctx: Ctx, opts: { canSeeUnpublished: boolean, scope?: string[] | null }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select w.id as wave_id, w.title as wave, w.starts_at, w.status, l.id as location_id, l.name as location,
             round(avg(r.score), 1) as avg_score, count(r.id)::int as runs, count(*) filter (where r.passed)::int as passed
      from mystery_waves w
      join checklist_runs r on r.wave_id = w.id and r.status = 'finished'
      join locations l on l.id = r.location_id
      where true ${opts.canSeeUnpublished ? sql`` : sql`and w.status = 'published'`} ${scopeSql(opts.scope ?? null, sql`l.id`)}
      group by 1, 2, 3, 4, 5, 6 order by w.starts_at desc, l.name
    `) as unknown as { wave_id: string, wave: string, starts_at: string, status: string, location_id: string, location: string, avg_score: string, runs: number, passed: number }[]
    const waves = [...new Map(rows.map(r => [r.wave_id, { id: r.wave_id, title: r.wave, startsAt: r.starts_at, status: r.status }])).values()]
    const locs = [...new Map(rows.map(r => [r.location_id, { id: r.location_id, name: r.location }])).values()].sort((a, b) => a.name.localeCompare(b.name))
    const cell = new Map(rows.map(r => [`${r.wave_id}:${r.location_id}`, { avg: Number(r.avg_score), runs: r.runs, passed: r.passed }]))
    return { waves, locations: locs, cells: Object.fromEntries(cell) }
  })
}

