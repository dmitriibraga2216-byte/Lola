import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { z } from 'zod'
import {
  assignmentCompetencies, assignments, automationRules, competencies, enrollmentEvents, enrollments, importJobs,
  programEnrollments, taskParameterValues, taskParameters, users,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'
import { recordAudit } from './audit'
import { resolveAudience } from './audience'
import { enqueueNotification } from './notifications'
import { parseImportFile } from './importPeople'
import { matchesConditions } from './automation'
import type { Conditions } from './automation'
import {
  DEFAULT_REMINDERS, METHOD_KEYS, paramsFor, parseTaskParams, remindersSchema,
} from '../../shared/schemas/assignments'
import type {
  Audience, AudienceBuilder, audienceAssignSchema, audienceQuerySchema, taskParameterSchema, taskParameterValuesSchema,
} from '../../shared/schemas/assignments'
import type { ContentType } from '../../shared/enums'

/**
 * Назначение по эталону (docs/15 §14, docs/04 §4.9 `/tasks/...`): параметры пяти групп,
 * напоминания Г-15.1, аудитория списком/CSV/конструктором, «Спосіб призначення»,
 * компетенции Г-15.3, доп. параметры §14.5, баннер «N завдань змінено» §14.6, Г-15.2.
 * Сервис дополняет assignments.ts (создание/раскрытие/отмена), не заменяет его.
 */

interface Ctx { tenantId: string, actorId: string }

type Tx = TenantTx
type AssignmentRow = typeof assignments.$inferSelect

async function loadTask(tx: Tx, id: string): Promise<AssignmentRow | null> {
  const [a] = await tx.select().from(assignments).where(eq(assignments.id, id))
  return a ?? null
}

// ── Параметры (docs/15 §14.3): пять групп, состав по типу контента ─────────────────────

export async function getTaskParams(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const a = await loadTask(tx, id)
    if (!a) return null
    return serializeParams(a)
  })
}

function serializeParams(a: AssignmentRow) {
  return {
    contentType: a.subjectType as ContentType,
    params: paramsFor(a.subjectType as ContentType, a.params as Record<string, unknown>),
    method: { viaCatalog: a.viaCatalog, automationRuleId: a.automationRuleId, useInDevPlans: a.useInDevPlans },
    dueMode: a.dueMode, dueDays: a.dueDays, dueAt: a.dueAt,
  }
}

export type PutParamsResult
  = | { ok: true, data: ReturnType<typeof serializeParams> }
    | { ok: false, code: 'not_found' | 'validation_failed', issues?: z.ZodIssue[] }

/** PUT /tasks/:id/params — тело валидируется схемой типа контента назначения; «Метод призначення» пишется колонками. */
export async function putTaskParams(ctx: Ctx, id: string, body: unknown): Promise<PutParamsResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const a = await loadTask(tx, id)
    if (!a) return { ok: false, code: 'not_found' }
    const p = parseTaskParams(a.subjectType as ContentType, body)
    if (!p.success) return { ok: false, code: 'validation_failed', issues: p.error.issues }
    const { contentType: _ct, viaCatalog, automationRuleId, useInDevPlans, ...rest } = p.data as Record<string, unknown> & { viaCatalog?: boolean, automationRuleId?: string | null, useInDevPlans?: boolean }
    if (automationRuleId) {
      const [rule] = await tx.select({ id: automationRules.id }).from(automationRules).where(eq(automationRules.id, automationRuleId))
      if (!rule) return { ok: false, code: 'validation_failed', issues: [{ code: 'custom', path: ['automationRuleId'], message: 'Правило автоматизації не знайдено' }] }
    }
    const [after] = await tx.update(assignments).set({
      params: paramsFor(a.subjectType as ContentType, rest),
      ...(viaCatalog !== undefined ? { viaCatalog } : {}),
      ...(automationRuleId !== undefined ? { automationRuleId } : {}),
      ...(useInDevPlans !== undefined ? { useInDevPlans } : {}),
      updatedAt: new Date(),
    }).where(eq(assignments.id, id)).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'assignment.params', entity: 'assignment', entityId: id, before: { params: a.params }, after: { params: after!.params, method: Object.fromEntries(METHOD_KEYS.map(k => [k, (after as Record<string, unknown>)[k]])) } })
    return { ok: true, data: serializeParams(after!) }
  })
}

// ── Напоминания (Г-15.1) ──────────────────────────────────────────────────────────────

export async function getReminders(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const a = await loadTask(tx, id)
    if (!a) return null
    return { ...DEFAULT_REMINDERS, ...(a.reminders as object) }
  })
}

export async function putReminders(ctx: Ctx, id: string, input: Partial<z.infer<typeof remindersSchema>>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const a = await loadTask(tx, id)
    if (!a) return null
    const merged = remindersSchema.parse({ ...DEFAULT_REMINDERS, ...(a.reminders as object), ...input })
    await tx.update(assignments).set({ reminders: merged, updatedAt: new Date() }).where(eq(assignments.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'assignment.reminders', entity: 'assignment', entityId: id, before: a.reminders, after: merged })
    return merged
  })
}

// ── Аудитория (docs/15 §14.4): фильтруемый список, «Спосіб призначення» ────────────────

/** Откуда человек получил задание — по kind назначения (task_type) и source записи. Отдельного перечисления нет. */
export type AssignedVia = 'manual' | 'auto' | 'catalog' | 'trajectory' | 'import' | 'self' | 'repeat'

function viaOf(kind: string, source?: string | null): AssignedVia {
  if (source === 'self' || source === 'catalog') return 'self'
  if (source === 'import' || source === 'repeat') return source
  if (source === 'automation') return 'auto'
  return (['manual', 'auto', 'catalog', 'trajectory'].includes(kind) ? kind : 'manual') as AssignedVia
}

interface AssignedInfo { assignedAt: Date, via: AssignedVia, enrollmentId: string | null, status: string | null }

/** Кто назначен: записи (курс/программа) поверх раскрытой аудитории (остальные типы записей не создают). */
async function assignedMap(tx: Tx, a: AssignmentRow): Promise<Map<string, AssignedInfo>> {
  const out = new Map<string, AssignedInfo>()
  const wanted = await resolveAudience(tx, a.audience as Audience, a.exclude as Audience)
  for (const userId of wanted) out.set(userId, { assignedAt: a.createdAt, via: viaOf(a.kind), enrollmentId: null, status: null })
  if (a.subjectType === 'course') {
    const rows = await tx.select({ id: enrollments.id, userId: enrollments.userId, createdAt: enrollments.createdAt, source: enrollments.source, status: enrollments.status, cancelledAt: enrollments.cancelledAt })
      .from(enrollments).where(eq(enrollments.assignmentId, a.id))
    for (const r of rows) {
      if (r.cancelledAt) { out.delete(r.userId); continue }
      out.set(r.userId, { assignedAt: r.createdAt, via: viaOf(a.kind, r.source), enrollmentId: r.id, status: r.status })
    }
  }
  else if (a.subjectType === 'training_program') {
    const rows = await tx.select({ id: programEnrollments.id, userId: programEnrollments.userId, createdAt: programEnrollments.createdAt, source: programEnrollments.source, status: programEnrollments.status, cancelledAt: programEnrollments.cancelledAt })
      .from(programEnrollments).where(eq(programEnrollments.assignmentId, a.id))
    for (const r of rows) {
      if (r.cancelledAt) { out.delete(r.userId); continue }
      out.set(r.userId, { assignedAt: r.createdAt, via: viaOf('trajectory', r.source), enrollmentId: r.id, status: r.status })
    }
  }
  return out
}

export async function listAudience(ctx: Ctx, id: string, q: z.infer<typeof audienceQuerySchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const a = await loadTask(tx, id)
    if (!a) return null
    const assigned = await assignedMap(tx, a)
    const people = await tx.execute(sql`
      select u.id, u.full_name, u.created_at as registered_at, u.tags,
             p.name as position, pl.name as position_level, l.name as location, ou.name as org_unit, c.name as city
      from users u
      left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
      left join positions p on p.id = up.position_id
      left join position_levels pl on pl.id = up.position_level_id
      left join locations l on l.id = up.location_id
      left join org_units ou on ou.id = l.org_unit_id
      left join cities c on c.id = l.city_id
      where u.status in ('invited','active') and not u.is_hidden
        ${q.q ? sql`and u.full_name ilike ${`%${q.q}%`}` : sql``}
        ${q.positionId ? sql`and up.position_id = ${q.positionId}::uuid` : sql``}
        ${q.positionLevelId ? sql`and up.position_level_id = ${q.positionLevelId}::uuid` : sql``}
        ${q.locationId ? sql`and up.location_id = ${q.locationId}::uuid` : sql``}
        ${q.cityId ? sql`and l.city_id = ${q.cityId}::uuid` : sql``}
        ${q.orgUnitId ? sql`and l.org_unit_id = ${q.orgUnitId}::uuid` : sql``}
        ${q.tag ? sql`and ${q.tag} = any(u.tags)` : sql``}
        ${q.registeredFrom ? sql`and u.created_at >= ${q.registeredFrom}::date` : sql``}
        ${q.registeredTo ? sql`and u.created_at < ${q.registeredTo}::date + 1` : sql``}
      order by u.full_name
    `) as unknown as { id: string, full_name: string, registered_at: Date, tags: string[], position: string | null, position_level: string | null, location: string | null, org_unit: string | null, city: string | null }[]

    const rows = people.map((p) => {
      const info = assigned.get(p.id) ?? null
      return {
        userId: p.id, fullName: p.full_name, registeredAt: p.registered_at, tags: p.tags, position: p.position, positionLevel: p.position_level,
        location: p.location, orgUnit: p.org_unit, city: p.city,
        assigned: !!info, assignedAt: info?.assignedAt ?? null, via: info?.via ?? null, enrollmentId: info?.enrollmentId ?? null, status: info?.status ?? null,
      }
    })
    const counts = { all: rows.length, assigned: rows.filter(r => r.assigned).length, unassigned: rows.filter(r => !r.assigned).length }
    const inRange = (d: Date | null) => !d ? false : (!q.assignedFrom || d >= new Date(q.assignedFrom)) && (!q.assignedTo || d < new Date(new Date(q.assignedTo).getTime() + 86_400_000))
    const filtered = rows.filter(r =>
      (q.tab === 'all' || (q.tab === 'assigned') === r.assigned)
      && (!q.via || r.via === q.via)
      && (!(q.assignedFrom || q.assignedTo) || inRange(r.assignedAt)),
    )
    return { counts, items: filtered.slice(0, q.limit), total: filtered.length }
  })
}

// ── Конструктор (docs/15 §14.4): четыре измерения, у каждого «Всі, окрім» ────────────────

/** Множество людей по конструктору: измерения пересекаются; mode any = измерение не ограничивает. */
export async function resolveBuilder(tx: Tx, builder: AudienceBuilder): Promise<Set<string>> {
  const conds = [sql`u.status in ('invited','active') and not u.is_hidden`]
  for (const d of builder.dimensions) {
    if (d.mode === 'any' || d.values.length === 0) continue
    const not = d.mode === 'exclude' ? sql`not` : sql``
    const list = sql.join(d.values.map(v => sql`${v}`), sql`, `)
    switch (d.dimension) {
      case 'city':
        conds.push(sql`${not} exists (select 1 from user_placements up join locations l on l.id = up.location_id where up.user_id = u.id and up.ended_at is null and l.city_id in (${list}))`)
        break
      case 'position':
        conds.push(sql`${not} exists (select 1 from user_placements up where up.user_id = u.id and up.ended_at is null and up.position_id in (${list}))`)
        break
      case 'org_unit':
        conds.push(sql`${not} exists (select 1 from user_placements up join locations l on l.id = up.location_id join org_units ou on ou.id = l.org_unit_id
          where up.user_id = u.id and up.ended_at is null and exists (select 1 from org_units parent where parent.id in (${list}) and ou.path <@ parent.path))`)
        break
      case 'tag':
        conds.push(sql`${not} (u.tags && array[${list}]::text[])`)
        break
    }
  }
  const rows = await tx.execute(sql`select u.id from users u where ${sql.join(conds, sql` and `)}`) as unknown as { id: string }[]
  return new Set(rows.map(r => r.id))
}

export async function previewBuilder(ctx: Ctx, id: string, builder: AudienceBuilder) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const a = await loadTask(tx, id)
    if (!a) return null
    const set = await resolveBuilder(tx, builder)
    const assigned = await assignedMap(tx, a)
    const ids = [...set]
    const sample = ids.length ? await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, ids.slice(0, 20))) : []
    return { count: ids.length, alreadyAssigned: ids.filter(i => assigned.has(i)).length, sample }
  })
}

/** Добавить людей в аудиторию: правило type=user растёт, из exclude они убираются; для курса/программы — раскрытие записей. */
async function addUsersToAudience(tx: Tx, a: AssignmentRow, userIds: string[]) {
  const audience = structuredClone(a.audience as Audience)
  const exclude = structuredClone((a.exclude ?? { rules: [], match: 'any' }) as Audience)
  let userRule = audience.rules.find(r => r.type === 'user') as { type: 'user', ids: string[] } | undefined
  if (!userRule) { userRule = { type: 'user', ids: [] }; audience.rules.push(userRule) }
  const have = new Set(userRule.ids)
  const added = userIds.filter(u => !have.has(u))
  userRule.ids.push(...added)
  for (const r of exclude.rules) if (r.type === 'user') r.ids = r.ids.filter(i => !userIds.includes(i))
  exclude.rules = exclude.rules.filter(r => r.type !== 'user' || r.ids.length > 0)
  // Снятая ранее запись открывается заново (снятие — признак, а не удаление)
  const reopened = a.subjectType === 'course'
    ? await tx.update(enrollments).set({ cancelledAt: null, cancelledBy: null, cancelReason: null, updatedAt: new Date() })
        .where(and(eq(enrollments.assignmentId, a.id), inArray(enrollments.userId, userIds), sql`${enrollments.cancelledAt} is not null`)).returning({ id: enrollments.id })
    : []
  await tx.update(assignments).set({ audience, exclude, updatedAt: new Date() }).where(eq(assignments.id, a.id))
  return { added, reopened: reopened.length }
}

export type AssignResult = { ok: true, added: number, reopened: number, expanded: number } | { ok: false, code: 'not_found' | 'no_users' }

/** POST /tasks/:id/audience/assign — `{userIds[]}` или `{filter}` (конструктор). */
export async function assignAudience(ctx: Ctx, id: string, input: z.infer<typeof audienceAssignSchema>): Promise<AssignResult> {
  const res = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const a = await loadTask(tx, id)
    if (!a) return { ok: false as const, code: 'not_found' as const }
    let userIds: string[]
    if ('userIds' in input) {
      userIds = (await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, input.userIds), inArray(users.status, ['invited', 'active'])))).map(u => u.id)
    }
    else {
      userIds = [...await resolveBuilder(tx, input.filter)]
    }
    if (userIds.length === 0) return { ok: false as const, code: 'no_users' as const }
    const r = await addUsersToAudience(tx, a, userIds)
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'assignment.audience.assign', entity: 'assignment', entityId: id, after: { mode: 'userIds' in input ? 'list' : 'builder', requested: userIds.length, added: r.added.length, reopened: r.reopened, filter: 'filter' in input ? input.filter : undefined } })
    return { ok: true as const, added: r.added.length, reopened: r.reopened }
  })
  if (!res.ok) return res
  const { expandAssignment } = await import('./assignments')
  const expanded = await expandAssignment(ctx.tenantId, id)
  return { ...res, expanded }
}

/** DELETE /tasks/:id/audience/:userId — снятие: cancelled_at у записи, человек уходит в exclude (docs/04 §4.9). */
export async function removeFromAudience(ctx: Ctx, id: string, userId: string, reason = 'Знято адміністратором'): Promise<{ ok: true, cancelled: number } | { ok: false, code: 'not_found' }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const a = await loadTask(tx, id)
    if (!a) return { ok: false, code: 'not_found' }
    const audience = structuredClone(a.audience as Audience)
    const exclude = structuredClone((a.exclude ?? { rules: [], match: 'any' }) as Audience)
    for (const r of audience.rules) if (r.type === 'user') r.ids = r.ids.filter(i => i !== userId)
    audience.rules = audience.rules.filter(r => r.type !== 'user' || r.ids.length > 0)
    let ex = exclude.rules.find(r => r.type === 'user') as { type: 'user', ids: string[] } | undefined
    if (!ex) { ex = { type: 'user', ids: [] }; exclude.rules.push(ex) }
    if (!ex.ids.includes(userId)) ex.ids.push(userId)
    await tx.update(assignments).set({ audience, exclude, updatedAt: new Date() }).where(eq(assignments.id, id))

    const now = new Date()
    const rows = a.subjectType === 'course'
      ? await tx.update(enrollments).set({ cancelledAt: now, cancelledBy: ctx.actorId, cancelReason: reason, updatedAt: now })
          .where(and(eq(enrollments.assignmentId, id), eq(enrollments.userId, userId), isNull(enrollments.cancelledAt))).returning({ id: enrollments.id })
      : a.subjectType === 'training_program'
        ? await tx.update(programEnrollments).set({ cancelledAt: now, updatedAt: now })
            .where(and(eq(programEnrollments.assignmentId, id), eq(programEnrollments.userId, userId), isNull(programEnrollments.cancelledAt))).returning({ id: programEnrollments.id })
        : []
    if (a.subjectType === 'course' && rows.length) {
      await tx.insert(enrollmentEvents).values(rows.map(r => ({ tenantId: ctx.tenantId, enrollmentId: r.id, event: 'cancelled', payload: { reason }, actorId: ctx.actorId, requestContext: currentRequestContext() })))
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'assignment.audience.remove', entity: 'assignment', entityId: id, after: { userId, cancelled: rows.length, reason } })
    return { ok: true, cancelled: rows.length }
  })
}

// ── CSV (Г-15.4): ключ email | phone | external_id, необязательные due_at / starts_at ──

const KEY_HEADERS: Record<string, 'email' | 'phone' | 'external_id'> = {
  'email': 'email', 'e-mail': 'email', 'пошта': 'email',
  'phone': 'phone', 'телефон': 'phone',
  'external_id': 'external_id', 'externalid': 'external_id', 'зовнішній №': 'external_id', 'зовнішній id': 'external_id',
}
const DATE_HEADERS: Record<string, 'dueAt' | 'startsAt'> = {
  'due_at': 'dueAt', 'дедлайн': 'dueAt', 'термін': 'dueAt', 'starts_at': 'startsAt', 'старт': 'startsAt', 'початок': 'startsAt',
}

/** UTF-8 или CP1251 (Excel на Windows): если в UTF-8 есть символы замены — файл в кодировке Windows. */
export function decodeCsv(buffer: Buffer): Buffer {
  const utf = buffer.toString('utf-8')
  if (!utf.includes('�')) return buffer
  return Buffer.from(new TextDecoder('windows-1251').decode(buffer), 'utf-8')
}

function parseDate(v: string | undefined): Date | null | 'bad' {
  if (!v) return null
  const m = v.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
  const d = m ? new Date(`${m[3]}-${m[2]}-${m[1]}T23:59:59`) : new Date(v)
  return Number.isNaN(d.getTime()) ? 'bad' : d
}

export interface CsvRow { line: number, key: string, value: string, userId: string | null, fullName: string | null, dueAt: string | null, startsAt: string | null, status: 'found' | 'not_found' | 'already_assigned' | 'bad_date' | 'empty' }

export type CsvPreview = { ok: true, jobId: string, keyColumn: string, stats: { total: number, found: number, notFound: number, alreadyAssigned: number, errors: number }, rows: CsvRow[] } | { ok: false, code: 'not_found' | 'no_key_column' | 'empty' }

/** Предпросмотр: сколько найдено, не найдено, уже назначено — применяется только по подтверждению. */
export async function previewCsv(ctx: Ctx, id: string, fileName: string, buffer: Buffer): Promise<CsvPreview> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const a = await loadTask(tx, id)
    if (!a) return { ok: false, code: 'not_found' }
    const raw = await parseImportFile(fileName.toLowerCase().endsWith('.csv') ? fileName : `${fileName}.csv`, decodeCsv(buffer))
    if (raw.length === 0) return { ok: false, code: 'empty' }
    const headers = Object.keys(raw[0]!)
    const norm = (h: string) => h.trim().toLowerCase().replace(/^\uFEFF/, '')
    const keyHeader = headers.find(h => KEY_HEADERS[norm(h)])
    if (!keyHeader) return { ok: false, code: 'no_key_column' }
    const key = KEY_HEADERS[norm(keyHeader)]!
    const dueHeader = headers.find(h => DATE_HEADERS[norm(h)] === 'dueAt')
    const startsHeader = headers.find(h => DATE_HEADERS[norm(h)] === 'startsAt')

    const values = raw.map(r => (r[keyHeader] ?? '').trim()).filter(Boolean)
    const col = key === 'email' ? users.email : key === 'phone' ? users.phone : users.externalId
    const found = values.length
      ? await tx.select({ id: users.id, fullName: users.fullName, v: col }).from(users).where(and(inArray(col, values), inArray(users.status, ['invited', 'active'])))
      : []
    const byValue = new Map(found.map(f => [String(f.v).toLowerCase(), f]))
    const assigned = await assignedMap(tx, a)

    const rows: CsvRow[] = raw.map((r, i) => {
      const value = (r[keyHeader] ?? '').trim()
      const due = parseDate(dueHeader ? r[dueHeader] : undefined)
      const starts = parseDate(startsHeader ? r[startsHeader] : undefined)
      const base = { line: i + 2, key, value, dueAt: due instanceof Date ? due.toISOString() : null, startsAt: starts instanceof Date ? starts.toISOString() : null }
      if (!value) return { ...base, userId: null, fullName: null, status: 'empty' }
      const u = byValue.get(value.toLowerCase())
      if (!u) return { ...base, userId: null, fullName: null, status: 'not_found' }
      if (due === 'bad' || starts === 'bad') return { ...base, userId: u.id, fullName: u.fullName, status: 'bad_date' }
      return { ...base, userId: u.id, fullName: u.fullName, status: assigned.has(u.id) ? 'already_assigned' : 'found' }
    })
    const stats = {
      total: rows.length,
      found: rows.filter(r => r.status === 'found').length,
      notFound: rows.filter(r => r.status === 'not_found').length,
      alreadyAssigned: rows.filter(r => r.status === 'already_assigned').length,
      errors: rows.filter(r => r.status === 'bad_date' || r.status === 'empty').length,
    }
    // Протокол — как импорт людей (docs/15 Г-15.4): import_jobs kind=task_audience
    const [job] = await tx.insert(importJobs).values({
      tenantId: ctx.tenantId, kind: 'task_audience', source: 'csv', fileName, mapping: { key: keyHeader, dueAt: dueHeader ?? null, startsAt: startsHeader ?? null },
      options: { assignmentId: id }, rows, stats, status: 'ready', createdBy: ctx.actorId, requestContext: currentRequestContext(),
    }).returning({ id: importJobs.id })
    return { ok: true, jobId: job!.id, keyColumn: keyHeader, stats, rows: rows.slice(0, 200) }
  })
}

export type CsvApply = { ok: true, added: number, expanded: number, withDates: number } | { ok: false, code: 'not_found' | 'bad_status' }

/** Применение по подтверждению: найденные попадают в аудиторию, сроки из файла — в записи. */
export async function applyCsv(ctx: Ctx, id: string, jobId: string): Promise<CsvApply> {
  const res = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const a = await loadTask(tx, id)
    const [job] = await tx.select().from(importJobs).where(and(eq(importJobs.id, jobId), eq(importJobs.kind, 'task_audience')))
    if (!a || !job || (job.options as { assignmentId?: string }).assignmentId !== id) return { ok: false as const, code: 'not_found' as const }
    if (job.status !== 'ready') return { ok: false as const, code: 'bad_status' as const }
    const rows = (job.rows as CsvRow[]).filter(r => r.status === 'found' && r.userId)
    const r = rows.length ? await addUsersToAudience(tx, a, rows.map(x => x.userId!)) : { added: [], reopened: 0 }
    await tx.update(importJobs).set({ status: 'applied', startedAt: new Date(), finishedAt: new Date(), updatedAt: new Date() }).where(eq(importJobs.id, jobId))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'assignment.audience.import', entity: 'assignment', entityId: id, after: { jobId, added: r.added.length, total: (job.stats as { total: number }).total } })
    return { ok: true as const, added: r.added.length, rows, subjectType: a.subjectType }
  })
  if (!res.ok) return res
  const { expandAssignment } = await import('./assignments')
  const expanded = await expandAssignment(ctx.tenantId, id)
  // Сроки по строкам файла — «одно завдання з різними строками по точках» (Г-15.4)
  let withDates = 0
  if (res.subjectType === 'course') {
    await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
      for (const row of res.rows) {
        if (!row.dueAt && !row.startsAt) continue
        const upd = await tx.update(enrollments).set({
          ...(row.dueAt ? { dueAt: new Date(row.dueAt) } : {}),
          ...(row.startsAt ? { startsAt: new Date(row.startsAt) } : {}),
          updatedAt: new Date(),
        }).where(and(eq(enrollments.assignmentId, id), eq(enrollments.userId, row.userId!), isNull(enrollments.cancelledAt))).returning({ id: enrollments.id })
        withDates += upd.length
      }
    })
  }
  return { ok: true, added: res.added, expanded, withDates }
}

// ── Компетенции (Г-15.3) ─────────────────────────────────────────────────────────────

export async function getCompetencies(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const a = await loadTask(tx, id)
    if (!a) return null
    return tx.select({ id: competencies.id, name: competencies.name, kind: competencies.kind })
      .from(assignmentCompetencies).innerJoin(competencies, eq(competencies.id, assignmentCompetencies.competencyId))
      .where(eq(assignmentCompetencies.assignmentId, id)).orderBy(competencies.name)
  })
}

export async function setCompetencies(ctx: Ctx, id: string, competencyIds: string[]) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const a = await loadTask(tx, id)
    if (!a) return null
    const valid = competencyIds.length ? (await tx.select({ id: competencies.id }).from(competencies).where(inArray(competencies.id, competencyIds))).map(c => c.id) : []
    const before = (await tx.select({ id: assignmentCompetencies.competencyId }).from(assignmentCompetencies).where(eq(assignmentCompetencies.assignmentId, id))).map(r => r.id)
    await tx.delete(assignmentCompetencies).where(eq(assignmentCompetencies.assignmentId, id))
    if (valid.length) await tx.insert(assignmentCompetencies).values(valid.map(competencyId => ({ tenantId: ctx.tenantId, assignmentId: id, competencyId })))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'assignment.competencies', entity: 'assignment', entityId: id, before: { competencyIds: before }, after: { competencyIds: valid } })
    return valid
  })
}

// ── «Додаткові параметри для завдань» (docs/15 §14.5) ─────────────────────────────────

export async function listTaskParameters(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => tx.select().from(taskParameters).orderBy(taskParameters.name))
}

export async function createTaskParameter(ctx: Ctx, input: z.infer<typeof taskParameterSchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.insert(taskParameters).values({ tenantId: ctx.tenantId, ...input }).onConflictDoNothing().returning()
    if (!row) return null // имя занято
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'task_parameter.create', entity: 'task_parameter', entityId: row.id, after: input })
    return row
  })
}

export async function updateTaskParameter(ctx: Ctx, id: string, input: Partial<z.infer<typeof taskParameterSchema>>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.update(taskParameters).set({ ...input, updatedAt: new Date() }).where(eq(taskParameters.id, id)).returning()
    if (row) await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'task_parameter.update', entity: 'task_parameter', entityId: id, after: input })
    return row ?? null
  })
}

export async function deleteTaskParameter(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.delete(taskParameters).where(eq(taskParameters.id, id)).returning({ id: taskParameters.id })
    if (row) await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'task_parameter.delete', entity: 'task_parameter', entityId: id })
    return !!row
  })
}

export async function getTaskParameterValues(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const a = await loadTask(tx, id)
    if (!a) return null
    const defs = await tx.select().from(taskParameters).orderBy(taskParameters.name)
    const vals = await tx.select({ parameterId: taskParameterValues.parameterId, value: taskParameterValues.value }).from(taskParameterValues).where(eq(taskParameterValues.taskId, id))
    const map = new Map(vals.map(v => [v.parameterId, v.value]))
    return defs.map(d => ({ ...d, value: map.get(d.id) ?? null }))
  })
}

export type ValuesResult = { ok: true } | { ok: false, code: 'not_found' | 'validation_failed', issues: { path: string[], message: string }[] }

/** Значения проверяются по типу параметра: число — число, список — из вариантов, обязательный — не пустой. */
export async function putTaskParameterValues(ctx: Ctx, id: string, input: z.infer<typeof taskParameterValuesSchema>): Promise<ValuesResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const a = await loadTask(tx, id)
    if (!a) return { ok: false, code: 'not_found', issues: [] }
    const defs = await tx.select().from(taskParameters)
    const issues: { path: string[], message: string }[] = []
    const rows: { parameterId: string, value: unknown }[] = []
    for (const d of defs) {
      const v = input.values[d.id]
      const empty = v === undefined || v === null || v === ''
      if (empty) { if (d.isRequired) issues.push({ path: [d.id], message: `«${d.name}» — обовʼязковий параметр` }); if (v !== undefined) rows.push({ parameterId: d.id, value: null }); continue }
      if (d.kind === 'number' && typeof v !== 'number') { issues.push({ path: [d.id], message: `«${d.name}» має бути числом` }); continue }
      if (d.kind === 'select' && !(d.options as string[]).includes(String(v))) { issues.push({ path: [d.id], message: `«${d.name}»: оберіть значення зі списку` }); continue }
      if (d.kind === 'text' && typeof v !== 'string') { issues.push({ path: [d.id], message: `«${d.name}» має бути текстом` }); continue }
      rows.push({ parameterId: d.id, value: v })
    }
    for (const k of Object.keys(input.values)) if (!defs.some(d => d.id === k)) issues.push({ path: [k], message: 'Невідомий параметр' })
    if (issues.length) return { ok: false, code: 'validation_failed', issues }
    for (const r of rows) {
      await tx.insert(taskParameterValues).values({ tenantId: ctx.tenantId, taskId: id, parameterId: r.parameterId, value: r.value })
        .onConflictDoUpdate({ target: [taskParameterValues.taskId, taskParameterValues.parameterId], set: { value: r.value } })
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'assignment.parameters', entity: 'assignment', entityId: id, after: input.values })
    return { ok: true }
  })
}

// ── «N завдань було змінено» (docs/15 §14.6): правка контента копится, рассылка — по команде ──

/** Вызывается из публикации/правки контента внутри той же транзакции. */
export async function markContentChanged(tx: Tx, contentType: ContentType, contentId: string) {
  await tx.update(assignments).set({ contentChangedAt: sql`now()` })
    .where(and(eq(assignments.subjectType, contentType), eq(assignments.subjectId, contentId), inArray(assignments.status, ['active', 'paused'])))
}

const changedWhere = sql`${assignments.contentChangedAt} is not null and (${assignments.contentChangeNotifiedAt} is null or ${assignments.contentChangeNotifiedAt} < ${assignments.contentChangedAt})`

export async function listChanged(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const items = await tx.select({ id: assignments.id, title: assignments.title, subjectType: assignments.subjectType, contentChangedAt: assignments.contentChangedAt })
      .from(assignments).where(changedWhere).orderBy(assignments.contentChangedAt)
    return { count: items.length, items }
  })
}

/** «Сповістити призначених користувачів» — одно уведомление на человека и назначение за день. */
export async function notifyChanged(ctx: Ctx, ids?: string[]) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const list = await tx.select().from(assignments).where(and(changedWhere, ...(ids?.length ? [inArray(assignments.id, ids)] : [])))
    const day = new Date().toISOString().slice(0, 10)
    let notified = 0
    for (const a of list) {
      const people = await assignedMap(tx, a)
      for (const [userId, info] of people) {
        if (info.status === 'done') continue // завершившим правка не мешает
        if (await enqueueNotification(tx, { tenantId: ctx.tenantId, userId, code: 'assignment_content_updated', payload: { title: a.title, assignmentId: a.id, contentType: a.subjectType }, dedupKey: `content_updated:${a.id}:${userId}:${day}` })) notified++
      }
      await tx.update(assignments).set({ contentChangeNotifiedAt: sql`now()` }).where(eq(assignments.id, a.id))
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'assignment.content_updated.notify', entity: 'assignment', after: { assignments: list.map(a => a.id), notified } })
    return { assignments: list.length, notified }
  })
}

/** Снять баннер без рассылки. */
export async function dismissChanged(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.update(assignments).set({ contentChangeNotifiedAt: sql`now()` }).where(changedWhere).returning({ id: assignments.id })
    if (rows.length) await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'assignment.content_updated.dismiss', entity: 'assignment', after: { assignments: rows.map(r => r.id) } })
    return { dismissed: rows.length }
  })
}

// ── Г-15.2: человек перестал отвечать условию ─────────────────────────────────────────

/**
 * keep — ничего; cancel_unstarted — снимаются неначатые; cancel_all — все открытые.
 * Условие — аудитория назначения; у назначения правила (kind=auto) — условия правила.
 * Снятие — признак cancelled_at и событие, данные не удаляются. Вызывается из sync.
 */
export async function applyOnLeave(tenantId: string, assignmentId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const a = await loadTask(tx, assignmentId)
    if (!a || a.status !== 'active' || a.onLeaveCondition === 'keep' || a.subjectType !== 'course') return 0
    const open = await tx.select({ id: enrollments.id, userId: enrollments.userId, status: enrollments.status }).from(enrollments)
      .where(and(eq(enrollments.assignmentId, assignmentId), isNull(enrollments.cancelledAt), inArray(enrollments.status, ['not_started', 'in_progress'])))
    if (open.length === 0) return 0

    let stillMatches: (userId: string) => Promise<boolean>
    if (a.automationRuleId) {
      const [rule] = await tx.select().from(automationRules).where(eq(automationRules.id, a.automationRuleId))
      if (!rule) return 0
      stillMatches = userId => matchesConditions(tx, userId, rule.conditions as Conditions)
    }
    else {
      const wanted = await resolveAudience(tx, a.audience as Audience, a.exclude as Audience)
      stillMatches = async userId => wanted.has(userId)
    }

    const now = new Date()
    let n = 0
    for (const e of open) {
      if (await stillMatches(e.userId)) continue
      if (a.onLeaveCondition === 'cancel_unstarted' && e.status !== 'not_started') continue
      await tx.update(enrollments).set({ cancelledAt: now, cancelledBy: null, cancelReason: 'left_condition', updatedAt: now }).where(eq(enrollments.id, e.id))
      await tx.insert(enrollmentEvents).values({ tenantId, enrollmentId: e.id, event: 'cancelled', payload: { reason: 'left_condition', onLeaveCondition: a.onLeaveCondition }, actorId: null, requestContext: currentRequestContext() })
      n++
    }
    if (n) await recordAudit(tx, { tenantId, actorId: null, action: 'assignment.on_leave', entity: 'assignment', entityId: assignmentId, after: { cancelled: n, onLeaveCondition: a.onLeaveCondition } })
    return n
  })
}
