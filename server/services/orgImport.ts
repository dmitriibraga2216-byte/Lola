import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { importJobs, locations, orgNodeAssignments, orgNodes, orgUnits, positions, users } from '../db/schema'
import { withTenant, type TenantTx } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { logOrgConflict } from './journals'
import { notifyManagerChangesFor } from './orgStructure'
import { applyPositionRoles } from './positionRoleMap'
import { loadNodes, lockOrgStructure, recomputeNodeStates, stateOf, takeSnapshot, writeNodeStates } from './orgTreeWrite'
import type { NodeState, OrgNodeRow } from './orgTreeWrite'
import { phoneSchema } from '../../shared/schemas/auth'
import {
  DEFAULT_ORG_IMPORT_OPTIONS, ORG_IMPORT_COLUMNS, ORG_IMPORT_LIMITS, applyOrgMapping, guessOrgMapping,
  normalizeCell, parseCsv, planOrgImport, snapshotForced, toCsv, unmappedRequired,
} from '../../shared/domain/orgImport'
import type {
  OrgImportColumn, OrgImportExistingNode, OrgImportOptions, OrgImportPlan, OrgImportRowResult, OrgImportStats,
} from '../../shared/domain/orgImport'
import type { OrgAssignmentEndReason } from '../../shared/enums'

/**
 * Импорт и выгрузка оргструктуры CSV (`docs/v2/32-org-structure.md` §6.2, §7 п. 7, §9, §11,
 * §13 критерий 6; PR-31 плана `docs/v2/45-plan.md`).
 *
 * Путь файла: загрузка → разбор и сопоставление колонок → предпросмотр («створити» /
 * «оновити» / «помилка») → опции → запуск. Запуск ставит задачу `org.import_apply`
 * (`32` §11), и она применяет **весь файл одной транзакцией** под блокировкой «одна
 * реорганизация на тенант»: перед записью — снимок `pre_import`, после — конфликты по
 * отклонённым строкам, журнал и письмо инициатору `org_structure_import_finished` со
 * счётчиками. Частично применённого дерева не бывает: транзакция либо проходит целиком,
 * либо не оставляет следа, а строки с ошибками отклоняются до записи.
 *
 * Правила «что считать ошибкой» — `shared/domain/orgImport.ts`; здесь только загрузка
 * контекста и запись. План считается заново в момент применения: дерево между
 * предпросмотром и запуском могли поменять.
 *
 * Задание хранится в `import_jobs` с `kind='org_structure'` — колонка `kind` у таблицы уже
 * есть (её фильтрует история импорта людей, её же использует аудитория заданий), и вид
 * импорта пишется туда, а не в `options.entity` (правка `32` §7 п. 7, PR-31).
 */

interface Ctx { tenantId: string, actorId: string | null }

export const ORG_IMPORT_KIND = 'org_structure'

/** Задание, зависшее дольше этого в `queued`/`applying` (упал процесс воркера), считается упавшим. */
const STALE_MINUTES = 30

interface StoredRow { line: number, raw: Record<string, string>, result?: OrgImportRowResult }

export interface OrgImportStoredStats extends Partial<OrgImportStats> {
  created?: number
  updated?: number
  archived?: number
  assignmentsCreated?: number
  assignmentsEnded?: number
  conflicts?: number
  snapshotId?: string | null
  error?: string
  /** Привязок файла, которые что-то меняют (новые, другая роль или признак основного). */
  assignmentsChanged?: number
}

export interface OrgImportView {
  jobId: string
  fileName: string
  status: string
  headers: string[]
  mapping: Record<string, string>
  options: OrgImportOptions
  snapshotForced: boolean
  unmapped: OrgImportColumn[]
  stats: OrgImportStoredStats
  rows: OrgImportRowResult[]
  createdAt: string
  finishedAt: string | null
}

export type OrgImportFileError = 'file_encoding' | 'file_empty' | 'too_many_rows' | 'file_too_large'

/**
 * Разбор файла: UTF-8 (с BOM или без), разделитель из заголовка. Файл в другой кодировке
 * отклоняется целиком, а не превращается в «кракозябры» в названиях узлов.
 */
export function parseOrgImportFile(buffer: Buffer): { ok: true, headers: string[], records: Record<string, string>[] } | { ok: false, code: OrgImportFileError } {
  if (buffer.length > ORG_IMPORT_LIMITS.maxBytes) return { ok: false, code: 'file_too_large' }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  }
  catch {
    return { ok: false, code: 'file_encoding' }
  }
  const { headers, rows } = parseCsv(text)
  if (!headers.length || !rows.length) return { ok: false, code: 'file_empty' }
  if (rows.length > ORG_IMPORT_LIMITS.maxRows) return { ok: false, code: 'too_many_rows' }
  const records = rows.map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])))
  return { ok: true, headers, records }
}

// ── Контекст плана ───────────────────────────────────────────────────────────────────────

/**
 * Всё, что нужно плану из базы: узлы (включая архивные — их пути тоже обязаны сходиться),
 * справочники и люди, упомянутые в файле. Людей ищем только среди сотрудников (правило 17):
 * кандидата в дерево подчинения не ставят, и «не найден» для него честнее, чем привязка.
 */
async function planFor(tx: TenantTx, current: ReadonlyMap<string, OrgNodeRow>, rows: StoredRow[], mapping: Record<string, string>, options: OrgImportOptions): Promise<OrgImportPlan> {
  const mapped = rows.map(r => ({ line: r.line, values: applyOrgMapping(r.raw, mapping) }))
  const holders = await tx.execute(sql`select node_id::text as node_id, count(*)::int as n from org_node_assignments where ended_at is null group by node_id`) as unknown as { node_id: string, n: number }[]
  const holderCount = new Map(holders.map(h => [h.node_id, h.n]))
  const existing: OrgImportExistingNode[] = [...current.values()].map(n => ({
    id: n.id,
    externalKey: n.externalKey,
    parentId: n.parentId,
    path: n.path,
    archived: n.state === 'archived',
    type: n.type as OrgImportExistingNode['type'],
    title: n.title,
    positionId: n.positionId,
    orgUnitId: n.orgUnitId,
    locationId: n.locationId,
    headcountPlanned: n.headcountPlanned,
    isManagerPoint: n.isManagerPoint,
    sort: n.sort,
    activeHolders: holderCount.get(n.id) ?? 0,
  }))

  const [pos, units, locs] = await Promise.all([
    tx.select({ id: positions.id, name: positions.name, isActive: positions.isActive }).from(positions),
    tx.select({ id: orgUnits.id, name: orgUnits.name }).from(orgUnits),
    tx.select({ id: locations.id, name: locations.name, isActive: locations.isActive }).from(locations),
  ])

  const refs = [...new Set(mapped.map(r => normalizeCell(r.values.employee_external_id ?? '')).filter(Boolean))]
  const phones = new Map<string, string>()
  for (const ref of refs) {
    const p = phoneSchema.safeParse(ref)
    if (p.success) phones.set(ref, p.data)
  }
  const found = refs.length
    ? await tx.select({ id: users.id, externalId: users.externalId, phone: users.phone, status: users.status }).from(users)
        .where(and(eq(users.kind, 'employee'), sql`(${users.externalId} in (${sql.join(refs.map(r => sql`${r}`), sql`, `)})${phones.size ? sql` or ${users.phone} in (${sql.join([...phones.values()].map(p => sql`${p}`), sql`, `)})` : sql``})`))
    : []
  const byExternal = new Map(found.filter(u => u.externalId).map(u => [u.externalId!, u]))
  const byPhone = new Map(found.filter(u => u.phone).map(u => [u.phone!, u]))

  return planOrgImport({
    rows: mapped,
    existing,
    refs: {
      positions: new Map(pos.filter(p => p.isActive).map(p => [p.name.toLowerCase(), p.id])),
      inactivePositions: new Set(pos.filter(p => !p.isActive).map(p => p.name.toLowerCase())),
      orgUnits: new Map(units.map(u => [u.name.toLowerCase(), u.id])),
      locations: new Map(locs.filter(l => l.isActive).map(l => [l.name.toLowerCase(), l.id])),
      inactiveLocations: new Set(locs.filter(l => !l.isActive).map(l => l.name.toLowerCase())),
    },
    // Порядок идентификации — как у импорта людей (`docs/06` §6.5.6): зовнішній №, потом телефон.
    person: (ref) => {
      const u = byExternal.get(ref) ?? (phones.has(ref) ? byPhone.get(phones.get(ref)!) : undefined)
      return u ? { id: u.id, archived: u.status === 'archived' } : null
    },
    options,
    newId: () => crypto.randomUUID(),
  })
}

function normalizeOptions(input: Partial<OrgImportOptions> | undefined, rowCount: number): OrgImportOptions {
  const o = { ...DEFAULT_ORG_IMPORT_OPTIONS, ...input }
  // «Зробити знімок перед імпортом» при > 50 строках снять нельзя (`32` §6.2) — и сервер это держит.
  return snapshotForced(rowCount) ? { ...o, snapshot: true } : o
}

function viewOf(job: typeof importJobs.$inferSelect): OrgImportView {
  const rows = job.rows as StoredRow[]
  const mapping = (job.mapping ?? {}) as Record<string, string>
  return {
    jobId: job.id,
    fileName: job.fileName,
    status: job.status,
    headers: Object.keys(mapping),
    mapping,
    options: normalizeOptions(job.options as Partial<OrgImportOptions>, rows.length),
    snapshotForced: snapshotForced(rows.length),
    unmapped: unmappedRequired(mapping),
    stats: job.stats as OrgImportStoredStats,
    rows: rows.map(r => r.result ?? { line: r.line, key: '', parentKey: '', title: '', employee: '', action: 'error', errors: [], warnings: [] }),
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
  }
}

async function jobOf(tx: TenantTx, jobId: string) {
  const [job] = await tx.select().from(importJobs).where(and(eq(importJobs.id, jobId), eq(importJobs.kind, ORG_IMPORT_KIND)))
  return job ?? null
}

/**
 * Сколько привязок файла что-то меняют. Повторный импорт выгрузки называет всех держателей
 * заново — это не изменение, и запускать такой файл незачем (`422 nothing_to_apply`).
 */
async function assignmentChanges(tx: TenantTx, plan: OrgImportPlan): Promise<number> {
  if (!plan.assignments.length) return 0
  const active = await tx.select({ nodeId: orgNodeAssignments.nodeId, userId: orgNodeAssignments.userId, isPrimary: orgNodeAssignments.isPrimary, roleInNode: orgNodeAssignments.roleInNode })
    .from(orgNodeAssignments).where(isNull(orgNodeAssignments.endedAt))
  const byKey = new Map(active.map(a => [`${a.nodeId}:${a.userId}`, a]))
  return plan.assignments.filter((a) => {
    const cur = byKey.get(`${a.nodeId}:${a.userId}`)
    return !cur || cur.isPrimary !== a.isPrimary || cur.roleInNode !== a.role
  }).length
}

/** Предпросмотр: план по текущему дереву, результаты строк — в задание. */
async function revalidate(tx: TenantTx, job: typeof importJobs.$inferSelect, mapping: Record<string, string>, options: OrgImportOptions) {
  const rows = job.rows as StoredRow[]
  const plan = await planFor(tx, await loadNodes(tx), rows, mapping, options)
  const byLine = new Map(plan.rows.map(r => [r.line, r]))
  const [saved] = await tx.update(importJobs).set({
    mapping,
    options,
    rows: rows.map(r => ({ line: r.line, raw: r.raw, result: byLine.get(r.line) })),
    stats: { ...plan.stats, assignmentsChanged: await assignmentChanges(tx, plan) },
    status: 'ready',
    updatedAt: new Date(),
  }).where(eq(importJobs.id, job.id)).returning()
  return saved!
}

/** Шаг «загрузка»: задание, сопоставление по заголовкам, предпросмотр. */
export async function startOrgImport(ctx: Ctx, fileName: string, parsed: { headers: string[], records: Record<string, string>[] }): Promise<OrgImportView> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const guessed = guessOrgMapping(parsed.headers)
    const mapping = Object.fromEntries(parsed.headers.map(h => [h, guessed[h] ?? '']))
    const options = normalizeOptions(undefined, parsed.records.length)
    const rows: StoredRow[] = parsed.records.map((raw, i) => ({ line: i + 2, raw }))
    const [job] = await tx.insert(importJobs).values({
      tenantId: ctx.tenantId,
      kind: ORG_IMPORT_KIND,
      source: 'csv',
      fileName,
      mapping,
      options,
      rows,
      status: 'validating',
      createdBy: ctx.actorId,
      requestContext: currentRequestContext(),
    }).returning()
    return viewOf(await revalidate(tx, job!, mapping, options))
  })
}

/** Шаги «сопоставление» и «опции»: те же строки заново по новому сопоставлению. */
export async function remapOrgImport(ctx: Ctx, jobId: string, input: { mapping?: Record<string, string>, options?: Partial<OrgImportOptions> }): Promise<{ ok: true, view: OrgImportView } | { ok: false, code: 'not_found' | 'not_ready' | 'mapping_invalid' }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const job = await jobOf(tx, jobId)
    if (!job) return { ok: false as const, code: 'not_found' as const }
    if (job.status !== 'ready') return { ok: false as const, code: 'not_ready' as const }
    const current = (job.mapping ?? {}) as Record<string, string>
    const mapping = input.mapping ? Object.fromEntries(Object.keys(current).map(h => [h, input.mapping![h] ?? ''])) : current
    // Одна колонка формата — один заголовок: иначе значение зависело бы от порядка столбцов.
    const targets = Object.values(mapping).filter(Boolean)
    if (targets.some(c => !(ORG_IMPORT_COLUMNS as readonly string[]).includes(c)) || new Set(targets).size !== targets.length) {
      return { ok: false as const, code: 'mapping_invalid' as const }
    }
    const options = normalizeOptions({ ...(job.options as Partial<OrgImportOptions>), ...input.options }, (job.rows as StoredRow[]).length)
    return { ok: true as const, view: viewOf(await revalidate(tx, job, mapping, options)) }
  })
}

export async function getOrgImport(ctx: Ctx, jobId: string): Promise<OrgImportView | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const job = await jobOf(tx, jobId)
    return job ? viewOf(job) : null
  })
}

/**
 * Идёт ли сейчас применение импорта оргструктуры. Задание старше получаса в `queued` или
 * `applying` — упавший воркер, а не работа: его закрывает `requestOrgImportApply()`.
 */
export async function orgImportActive(tx: TenantTx, exceptJobId?: string): Promise<boolean> {
  const [r] = await tx.execute(sql`
    select 1 from import_jobs
     where kind = ${ORG_IMPORT_KIND} and status in ('queued', 'applying')
       and updated_at > now() - make_interval(mins => ${STALE_MINUTES})
       ${exceptJobId ? sql`and id <> ${exceptJobId}::uuid` : sql``}
     limit 1`) as unknown as unknown[]
  return !!r
}

/**
 * «Запустити імпорт»: задание переходит в `queued`, вызывающий ставит `org.import_apply`.
 * Одно применение на тенант за раз — второй запуск получает `409 import_in_progress`
 * (и частичный уникальный индекс миграции 0089 держит это же в БД).
 */
export async function requestOrgImportApply(ctx: Ctx, jobId: string): Promise<{ ok: true } | { ok: false, code: 'not_found' | 'not_ready' | 'import_in_progress' | 'nothing_to_apply' | 'mapping_invalid' }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const job = await jobOf(tx, jobId)
    if (!job) return { ok: false as const, code: 'not_found' as const }
    if (job.status !== 'ready') return { ok: false as const, code: 'not_ready' as const }
    if (unmappedRequired((job.mapping ?? {}) as Record<string, string>).length) return { ok: false as const, code: 'mapping_invalid' as const }
    const stats = job.stats as OrgImportStoredStats
    if (!(stats.create ?? 0) && !(stats.update ?? 0) && !(stats.assignmentsChanged ?? 0) && !(stats.archive ?? 0)) return { ok: false as const, code: 'nothing_to_apply' as const }
    await tx.execute(sql`
      update import_jobs set status = 'failed', finished_at = now(), updated_at = now(),
             stats = stats || jsonb_build_object('error', 'stale')
       where kind = ${ORG_IMPORT_KIND} and status in ('queued', 'applying')
         and updated_at <= now() - make_interval(mins => ${STALE_MINUTES})`)
    if (await orgImportActive(tx, job.id)) return { ok: false as const, code: 'import_in_progress' as const }
    await tx.update(importJobs).set({ status: 'queued', updatedAt: new Date() }).where(eq(importJobs.id, job.id))
    return { ok: true as const }
  })
}

/** Очередь недоступна — задание закрывается сразу, а не висит «в черзі» полчаса. */
export async function failOrgImport(tenantId: string, jobId: string, error: string): Promise<void> {
  await withTenant(tenantId, null, tx => tx.update(importJobs).set({ status: 'failed', finishedAt: new Date(), updatedAt: new Date(), stats: sql`${importJobs.stats} || jsonb_build_object('error', ${error}::text)` }).where(and(eq(importJobs.id, jobId), eq(importJobs.kind, ORG_IMPORT_KIND))))
}

// ── Применение (`org.import_apply`) ──────────────────────────────────────────────────────

export interface OrgImportOutcome {
  created: number
  updated: number
  archived: number
  errors: number
  assignmentsCreated: number
  assignmentsEnded: number
  conflicts: number
  snapshotId: string | null
}

/**
 * Тело фоновой задачи `org.import_apply` (`32` §11). Статус `applying` пишется отдельной
 * короткой транзакцией — его видит экран, пока идёт основная. Упавший импорт закрывается
 * `failed`, инициатору уходит `import_failed`; дерево при этом не тронуто — всё в одной
 * транзакции.
 */
export async function applyOrgImport(tenantId: string, jobId: string): Promise<OrgImportOutcome | null> {
  const job = await withTenant(tenantId, null, async (tx) => {
    const j = await jobOf(tx, jobId)
    if (!j || !['queued', 'applying'].includes(j.status)) return null
    await tx.update(importJobs).set({ status: 'applying', startedAt: new Date(), updatedAt: new Date() }).where(eq(importJobs.id, jobId))
    return j
  })
  if (!job) return null
  const ctx: Ctx = { tenantId, actorId: job.createdBy }
  try {
    return await withTenant(tenantId, job.createdBy, tx => applyInTx(tx, ctx, job))
  }
  catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 500)
    await withTenant(tenantId, null, async (tx) => {
      await tx.update(importJobs).set({ status: 'failed', finishedAt: new Date(), updatedAt: new Date(), stats: sql`${importJobs.stats} || jsonb_build_object('error', ${message}::text)` }).where(eq(importJobs.id, jobId))
      if (job.createdBy) await enqueueNotification(tx, { tenantId, userId: job.createdBy, code: 'import_failed', payload: { file: job.fileName, error: message }, dedupKey: `org_import_failed:${jobId}`, urgent: true })
    })
    console.error('[org.import_apply]', tenantId, jobId, err)
    return null
  }
}

async function applyInTx(tx: TenantTx, ctx: Ctx, job: typeof importJobs.$inferSelect): Promise<OrgImportOutcome> {
  await lockOrgStructure(tx, ctx.tenantId, true)
  const rows = job.rows as StoredRow[]
  const mapping = (job.mapping ?? {}) as Record<string, string>
  const options = normalizeOptions(job.options as Partial<OrgImportOptions>, rows.length)
  const current = await loadNodes(tx)
  const plan = await planFor(tx, current, rows, mapping, options)

  // Снимок — до первой записи и в той же транзакции: откатывать будет к дереву до импорта.
  const snapshotId = options.snapshot ? (await takeSnapshot(tx, ctx, { label: job.fileName, kind: 'pre_import' })).id : null

  // «Створювати відсутні посади».
  const positionIds = new Map<string, string>()
  for (const name of plan.positionsToCreate) {
    await tx.insert(positions).values({ tenantId: ctx.tenantId, name }).onConflictDoNothing()
    const [p] = await tx.select({ id: positions.id }).from(positions).where(sql`lower(${positions.name}) = ${name.toLowerCase()}`).limit(1)
    positionIds.set(name.toLowerCase(), p!.id)
  }

  // Узлы: из файла — целиком, вне файла — только путь (под ними переехал предок), к архивации — в архив.
  const states = new Map<string, NodeState>()
  for (const n of plan.nodes) {
    if (n.action === 'same') continue
    const base = current.get(n.id)
    states.set(n.id, {
      ...(base ? stateOf(base) : { note: null, createdBy: ctx.actorId, archivedAt: null }),
      id: n.id,
      parentId: n.parentId,
      path: n.path,
      depth: n.depth,
      sort: n.sort,
      type: n.type,
      title: n.title,
      externalKey: n.externalKey,
      positionId: n.positionId ?? (n.newPositionName ? positionIds.get(n.newPositionName.toLowerCase()) ?? null : null),
      orgUnitId: n.orgUnitId,
      locationId: n.locationId,
      headcountPlanned: n.headcountPlanned,
      isManagerPoint: n.isManagerPoint,
      archived: false,
      archivedAt: null,
    })
  }
  for (const r of plan.relaid) states.set(r.id, { ...(states.get(r.id) ?? stateOf(current.get(r.id)!)), path: r.path, depth: r.depth })
  const archiveNow = new Date().toISOString()
  for (const id of plan.archive) states.set(id, { ...(states.get(id) ?? stateOf(current.get(id)!)), archived: true, archivedAt: archiveNow })
  const ordered = [...states.values()].sort((a, b) => a.depth - b.depth)
  await writeNodeStates(tx, ctx.tenantId, ordered, current)

  const moves = await applyAssignments(tx, ctx, plan, current)
  await recomputeNodeStates(tx)
  for (const userId of moves.primaryChanged) await applyPositionRoles(tx, ctx, userId)
  await notifyManagerChangesFor(tx, ctx, moves.affected)

  // Отклонённые строки структуры — конфликты оргструктуры с источником «імпорт» (`32` §3.3, §12 п. 3).
  for (const c of plan.conflicts) {
    await logOrgConflict(tx, { tenantId: ctx.tenantId, kind: c.kind, severity: c.severity, source: 'import', importJobId: job.id, actorId: ctx.actorId, details: c.details })
  }

  // Журнал (`32` §7 п. 3): каждое изменение узла и держателя своей строкой, плюс итог импорта.
  for (const n of plan.nodes) {
    if (n.action === 'same') continue
    const action = n.isNew ? 'org_node.create' : n.restore ? 'org_node.restore' : n.changed.includes('parent') ? 'org_node.move' : 'org_node.update'
    const before = current.get(n.id)
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action,
      entity: 'org_node',
      entityId: n.id,
      before: before ? { title: before.title, parentId: before.parentId, type: before.type, isManagerPoint: before.isManagerPoint, headcountPlanned: before.headcountPlanned, state: before.state } : undefined,
      after: { importJobId: job.id, title: n.title, parentId: n.parentId, type: n.type, isManagerPoint: n.isManagerPoint, headcountPlanned: n.headcountPlanned, changed: n.changed },
    })
  }
  for (const id of plan.archive) {
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'org_node.archive', entity: 'org_node', entityId: id, before: { state: current.get(id)!.state }, after: { importJobId: job.id } })
  }
  for (const m of moves.log) {
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: m.action, entity: 'org_node', entityId: m.nodeId, after: { importJobId: job.id, userId: m.userId, ...m.details } })
  }

  const outcome: OrgImportOutcome = {
    created: plan.stats.create,
    updated: plan.stats.update,
    archived: plan.archive.length,
    errors: plan.stats.errors,
    assignmentsCreated: moves.created,
    assignmentsEnded: moves.ended,
    conflicts: plan.conflicts.length,
    snapshotId,
  }
  await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'org_structure.import', entity: 'org_structure', entityId: job.id, after: { fileName: job.fileName, ...outcome } })

  const byLine = new Map(plan.rows.map(r => [r.line, r]))
  await tx.update(importJobs).set({
    status: 'applied',
    finishedAt: new Date(),
    updatedAt: new Date(),
    rows: rows.map(r => ({ line: r.line, raw: r.raw, result: byLine.get(r.line) })),
    stats: { ...plan.stats, ...outcome },
  }).where(eq(importJobs.id, job.id))

  // «Імпорт оргструктури: створено {{created}}, оновлено {{updated}}, помилок {{errors}}» — инициатору (`32` §8).
  if (job.createdBy) {
    await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: job.createdBy, code: 'org_structure_import_finished', payload: { created: outcome.created, updated: outcome.updated, errors: outcome.errors, file: job.fileName }, dedupKey: `org_import_finished:${job.id}` })
  }
  return outcome
}

/**
 * Привязки из файла. Активная строка «узел × человек», которая есть в файле, остаётся (роль и
 * признак основного — из файла); прежнее основное человека, получившего основное в файле,
 * закрывается как `moved` (или становится совместительством, если файл так и говорит);
 * у именного узла прежний держатель заменяется человеком из файла. Всех остальных импорт
 * не трогает: файл «только дерево» не снимает людей.
 */
async function applyAssignments(tx: TenantTx, ctx: Ctx, plan: OrgImportPlan, current: ReadonlyMap<string, OrgNodeRow>) {
  const log: { action: 'org_node.assign_user' | 'org_node.unassign_user', nodeId: string, userId: string, details: Record<string, unknown> }[] = []
  const active = await tx.select().from(orgNodeAssignments).where(isNull(orgNodeAssignments.endedAt)).orderBy(asc(orgNodeAssignments.createdAt))
  const key = (nodeId: string, userId: string) => `${nodeId}:${userId}`
  const target = new Map(plan.assignments.map(a => [key(a.nodeId, a.userId), a]))
  const primaryTarget = new Map(plan.assignments.filter(a => a.isPrimary).map(a => [a.userId, a.nodeId]))
  const archived = new Set(plan.archive)
  const typeOf = new Map<string, string>([...current.values()].map(n => [n.id, n.type]))
  for (const n of plan.nodes) typeOf.set(n.id, n.type)
  const namedTarget = new Map(plan.assignments.filter(a => typeOf.get(a.nodeId) === 'employee').map(a => [a.nodeId, a.userId]))

  const beforePrimary = new Map(active.filter(a => a.isPrimary).map(a => [a.userId, a.nodeId]))
  let ended = 0
  const end = async (a: typeof active[number], reason: OrgAssignmentEndReason) => {
    await tx.execute(sql`update org_node_assignments set ended_at = greatest(current_date, started_at), ended_reason = ${reason}, updated_at = now() where id = ${a.id}::uuid`)
    ended++
    log.push({ action: 'org_node.unassign_user', nodeId: a.nodeId, userId: a.userId, details: { endedReason: reason } })
  }

  const kept: typeof active = []
  for (const a of active) {
    if (target.has(key(a.nodeId, a.userId))) kept.push(a)
    else if (archived.has(a.nodeId)) await end(a, 'node_archived')
    else if (a.isPrimary && primaryTarget.has(a.userId)) await end(a, 'moved')
    else if (namedTarget.has(a.nodeId) && namedTarget.get(a.nodeId) !== a.userId) await end(a, 'manual')
  }

  // Смена роли и признака основного: сначала снять, потом поставить — индекс «одно основное
  // на человека» проверяется построчно сразу.
  let updated = 0
  for (const pass of [false, true]) {
    for (const a of kept) {
      const t = target.get(key(a.nodeId, a.userId))!
      if (t.isPrimary !== pass || (t.isPrimary === a.isPrimary && t.role === a.roleInNode)) continue
      await tx.update(orgNodeAssignments).set({ isPrimary: t.isPrimary, roleInNode: t.role, updatedAt: new Date() }).where(eq(orgNodeAssignments.id, a.id))
      updated++
    }
  }

  const activeKeys = new Set(active.map(a => key(a.nodeId, a.userId)))
  const missing = plan.assignments.filter(a => !activeKeys.has(key(a.nodeId, a.userId)))
  const placements = new Map<string, string>()
  if (missing.length) {
    const ids = [...new Set(missing.map(a => a.userId))]
    const rows = await tx.execute(sql`
      select distinct on (user_id) user_id::text as user_id, id::text as id from user_placements
       where is_primary and ended_at is null and user_id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})
       order by user_id, started_at desc`) as unknown as { user_id: string, id: string }[]
    for (const r of rows) placements.set(r.user_id, r.id)
  }
  for (const a of [...missing].sort((x, y) => Number(x.isPrimary) - Number(y.isPrimary))) {
    await tx.insert(orgNodeAssignments).values({
      tenantId: ctx.tenantId,
      nodeId: a.nodeId,
      userId: a.userId,
      placementId: placements.get(a.userId) ?? null,
      isPrimary: a.isPrimary,
      roleInNode: a.role,
      ...(a.startedAt ? { startedAt: a.startedAt } : {}),
      createdBy: ctx.actorId,
    })
    log.push({ action: 'org_node.assign_user', nodeId: a.nodeId, userId: a.userId, details: { isPrimary: a.isPrimary, roleInNode: a.role } })
  }

  const after = await tx.select({ userId: orgNodeAssignments.userId, nodeId: orgNodeAssignments.nodeId }).from(orgNodeAssignments)
    .where(and(isNull(orgNodeAssignments.endedAt), eq(orgNodeAssignments.isPrimary, true)))
  const afterPrimary = new Map(after.map(a => [a.userId, a.nodeId]))
  const primaryChanged = [...new Set([...beforePrimary.keys(), ...afterPrimary.keys()])].filter(u => beforePrimary.get(u) !== afterPrimary.get(u))
  return {
    created: missing.length,
    ended,
    updated,
    log,
    primaryChanged,
    // Руководитель мог смениться у любого, кто в дереве: переехала ветка — сменился и держатель над ней.
    affected: [...new Set([...active.map(a => a.userId), ...plan.assignments.map(a => a.userId), ...after.map(a => a.userId)])],
  }
}

// ── Выгрузка («Експорт CSV», `32` §9) ────────────────────────────────────────────────────

/**
 * «Оргструктура» — CSV в формате импорта: UTF-8 с BOM, `;`. Узел без держателей — одна
 * строка, узел с несколькими — строка на каждого (колонки узла повторяются). Ключ узла без
 * `external_key` — его id: импорт найдёт узел по нему. Человек без зовнішнього № — по
 * телефону: тот же порядок, в котором импорт его ищет. Архивные узлы не выгружаются.
 */
export async function exportOrgStructureCsv(ctx: Ctx): Promise<string> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const nodes = await tx.select({
      id: orgNodes.id,
      parentId: orgNodes.parentId,
      externalKey: orgNodes.externalKey,
      type: orgNodes.type,
      title: orgNodes.title,
      positionName: positions.name,
      orgUnitName: orgUnits.name,
      locationName: locations.name,
      headcountPlanned: orgNodes.headcountPlanned,
      isManagerPoint: orgNodes.isManagerPoint,
      sort: orgNodes.sort,
    }).from(orgNodes)
      .leftJoin(positions, eq(positions.id, orgNodes.positionId))
      .leftJoin(orgUnits, eq(orgUnits.id, orgNodes.orgUnitId))
      .leftJoin(locations, eq(locations.id, orgNodes.locationId))
      .where(sql`${orgNodes.state} <> 'archived'`)
      .orderBy(asc(orgNodes.path))
    const keyOf = new Map(nodes.map(n => [n.id, n.externalKey ?? n.id]))
    const ids = nodes.map(n => n.id)
    const holders = ids.length
      ? await tx.select({
        nodeId: orgNodeAssignments.nodeId,
        role: orgNodeAssignments.roleInNode,
        isPrimary: orgNodeAssignments.isPrimary,
        startedAt: orgNodeAssignments.startedAt,
        externalId: users.externalId,
        phone: users.phone,
        fullName: users.fullName,
      }).from(orgNodeAssignments)
        .innerJoin(users, eq(users.id, orgNodeAssignments.userId))
        .where(and(isNull(orgNodeAssignments.endedAt), inArray(orgNodeAssignments.nodeId, ids)))
        .orderBy(asc(orgNodeAssignments.startedAt), asc(users.fullName))
      : []
    const byNode = new Map<string, typeof holders>()
    for (const h of holders) byNode.set(h.nodeId, [...(byNode.get(h.nodeId) ?? []), h])

    const out: (string | number | boolean | null)[][] = [[...ORG_IMPORT_COLUMNS]]
    for (const n of nodes) {
      const node = [keyOf.get(n.id)!, n.parentId ? keyOf.get(n.parentId) ?? n.parentId : '', n.type, n.title, n.positionName ?? '', n.orgUnitName ?? '', n.locationName ?? '', n.headcountPlanned, n.isManagerPoint]
      const list = byNode.get(n.id) ?? []
      if (!list.length) out.push([...node, '', '', '', n.sort, ''])
      for (const h of list) out.push([...node, h.externalId ?? h.phone ?? '', h.role, h.startedAt, n.sort, h.isPrimary])
    }
    return toCsv(out)
  })
}
