import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { absenceNorms, absenceRecords, enrollmentEvents, tenants, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'
import { ABSENCE_KINDS, ABSENCE_NORM_KINDS } from '../../shared/enums'
import type { AbsenceKind, AbsenceNormKind, AbsenceSource, AbsenceStatus } from '../../shared/enums'
import {
  absenceDays, absenceTransitionAllowed, daysInYear, planAroundAbsences, rangesOverlap, remainingDays, validateAbsenceRange,
} from '../../shared/domain/absences'
import type { AbsenceRangeError, DateRange } from '../../shared/domain/absences'
import type { IsoDate } from '../../shared/domain/personRecords'
import type { AbsenceRecordCreate, AbsenceRecordUpdate } from '../../shared/schemas/absences'
import type { Access } from './access'
import { areaCovers, areaOf, can } from './access'
import { currentYear, resolveAbsenceNorms } from './absenceNorms'
import type { NormSource } from './absenceNorms'
import { recordAudit } from './audit'
import { stageCan } from './lifecycle'
import { enqueueNotification } from './notifications'
import { managerIdOf } from './orgManager'
import { cardSubject, isUuid } from './personCard'
import type { CardSubject } from './personCard'
import { subjectStage } from './taskParams'

/**
 * Отсутствия человека (docs/v2/38-people-extensions.md §3.6, §4, §5.1, §6.3–6.4, §7.12–7.14; PR-33).
 *
 * **Граница (§7.12).** Lola не ведёт кадровый учёт: норма и остаток — справочные, дни —
 * календарные. У записи отсутствия одно функциональное следствие — планировщик не ставит дедлайн
 * обязательного обучения на дни отсутствия и не шлёт в эти дни напоминаний (§7.14).
 *
 * **Права (§2).** Свою норму, остаток и записи человек видит без скоупа. Чужие — носитель
 * `person.absence.manage` в области точки человека (руководитель — своих точек, HR и
 * администратор — всего тенанта); он же вносит и правит записи. Норму правит `PUT /absence-norms`
 * (PR-39): уровень компании — только грант на весь тенант.
 *
 * **Сдвиг дедлайна (§7.14).** Только у записи на курс **обязательного** назначения, только вперёд
 * (прошедший срок не воскрешается, §12) и только там, где у этапа курса включена возможность
 * `deadline` — решение принимает `stageCan()` (инвариант 16), ветки по коду этапа нет. Срок —
 * параметр назначения (CLAUDE.md п. 11): сдвигается `enrollments.due_at` записи, которую создало
 * назначение, с `deadline_shifted_reason = 'absence'`; контент не трогается. Каждый сдвиг — в
 * `audit_log` и `enrollment_events`, уведомление `absence_deadline_shifted` человеку и руководителю.
 */

type Area = 'tenant' | 'none' | string[]
interface Ctx { tenantId: string, actorId: string }

export interface AbsenceViewer {
  userId: string
  /** Область `person.absence.manage` (§2). */
  manage: Area
  /** «Перенести» прошедший дедлайн (§12) — тот же скоуп, что `POST /manage/enrollments/:id/extend`. */
  extend: boolean
  /** Токен интеграции: запись получает `source = 'api'`. */
  viaToken: boolean
}

export async function absenceViewerOf(access: Access): Promise<AbsenceViewer> {
  return {
    userId: access.userId,
    manage: await areaOf(access, 'person.absence.manage'),
    extend: can(access, 'assignment.create'),
    viaToken: !!access.viaToken,
  }
}

function canView(v: AbsenceViewer, s: CardSubject): boolean {
  return v.userId === s.id || areaCovers(v.manage, s.locationId)
}

function canManage(v: AbsenceViewer, s: CardSubject): boolean {
  return areaCovers(v.manage, s.locationId)
}

// ── Часовой пояс человека ─────────────────────────────────────────────────────────────────

async function tenantTimezone(tx: TenantTx, tenantId: string): Promise<string> {
  const [t] = await tx.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId))
  return t?.timezone ?? 'Europe/Kyiv'
}

/**
 * Пояс, в котором живут даты отсутствия человека: пояс точки основного размещения, иначе
 * тенанта — тот же порядок, что у тихих часов уведомлений (`enqueueNotification`, docs/23 §3.3).
 */
function personTz(userCol: SQL, tenantTz: string): SQL {
  return sql`coalesce((select l.timezone from user_placements up join locations l on l.id = up.location_id
    where up.user_id = ${userCol} and up.is_primary and up.ended_at is null order by up.started_at desc limit 1), ${tenantTz})`
}

// ── Записи ────────────────────────────────────────────────────────────────────────────────

export interface AbsenceRecordDto {
  id: string
  kind: AbsenceKind
  dateFrom: IsoDate
  dateTo: IsoDate
  daysCount: number
  /** Дни записи, приходящиеся на год карточки (§7.13: частично попавший период — пересечением). */
  daysInYear: number
  status: AbsenceStatus
  source: AbsenceSource
  comment: string | null
  createdBy: { id: string, name: string } | null
  createdAt: Date
  updatedAt: Date
}

type RecordRow = typeof absenceRecords.$inferSelect

function toDto(r: RecordRow, year: number, creatorName: string | null): AbsenceRecordDto {
  return {
    id: r.id,
    kind: r.kind as AbsenceKind,
    dateFrom: r.dateFrom,
    dateTo: r.dateTo,
    daysCount: Number(r.daysCount),
    daysInYear: daysInYear(r.dateFrom, r.dateTo, year),
    status: r.status as AbsenceStatus,
    source: r.source as AbsenceSource,
    comment: r.comment,
    createdBy: r.createdBy ? { id: r.createdBy, name: creatorName ?? '' } : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

// ── Блок карточки «Відсутності» (§5.1) ───────────────────────────────────────────────────

export interface AbsenceNormView {
  value: number
  /** «Норма компанії» / «Норма точки» / «Індивідуально» / системный дефолт (§5.1, §7.13). */
  source: NormSource
  /** Для индивидуальной нормы — кто и когда её поставил и почему («Індивідуально, HR, {дата}»). */
  setAt: Date | null
  setBy: string | null
  reason: string | null
}

export interface NormLevel { vacationDays: number | null, sickDays: number | null }

export interface MissedDeadline {
  enrollmentId: string
  title: string
  dueAt: Date
  absence: DateRange
}

export interface AbsenceCard {
  year: number
  person: { id: string, locationId: string | null, locationName: string | null, archived: boolean }
  norms: Record<AbsenceNormKind, AbsenceNormView>
  /** Значения уровней на год — форме «Скоригувати» для живого расчёта (§6.3); null — уровень не задан. */
  levels: { tenant: NormLevel | null, location: NormLevel | null, user: NormLevel | null }
  used: Record<AbsenceKind, number>
  remaining: Record<AbsenceNormKind, number>
  records: AbsenceRecordDto[]
  /** «Дедлайн минув під час відсутності» (§12): правило работает только вперёд, переносит человек. */
  missedDeadlines: MissedDeadline[]
  can: { record: boolean, adjust: { tenant: boolean, location: boolean, user: boolean }, extend: boolean }
}

const num = (v: string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v))

export type CardResult = { ok: true, card: AbsenceCard } | { ok: false, code: 'not_found' | 'forbidden' }

export async function getAbsenceCard(ctx: Ctx, viewer: AbsenceViewer, personId: string, year?: number): Promise<CardResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const s = await cardSubject(tx, personId)
    if (!s) return { ok: false, code: 'not_found' }
    if (!canView(viewer, s)) return { ok: false, code: 'forbidden' }
    const y = year ?? await currentYear(tx, ctx.tenantId)

    const resolved = await resolveAbsenceNorms(tx, { year: y, userId: s.id, locationId: s.locationId })
    const levelRows = await tx.select({
      scopeType: absenceNorms.scopeType,
      vacationDays: absenceNorms.vacationDays,
      sickDays: absenceNorms.sickDays,
      reason: absenceNorms.reason,
      updatedAt: absenceNorms.updatedAt,
      setByName: users.fullName,
    }).from(absenceNorms)
      // Обогащение именем того, кто правил норму: людей в выборку `left join` не добавляет
      .leftJoin(users, eq(users.id, absenceNorms.setBy))
      .where(and(eq(absenceNorms.year, y), sql`(${absenceNorms.scopeType} = 'tenant'
        or (${absenceNorms.scopeType} = 'location' and ${absenceNorms.scopeId} = ${s.locationId}::uuid)
        or (${absenceNorms.scopeType} = 'user' and ${absenceNorms.scopeId} = ${s.id}::uuid))`))
    const level = (scope: string): NormLevel | null => {
      const r = levelRows.find(x => x.scopeType === scope)
      return r ? { vacationDays: num(r.vacationDays), sickDays: num(r.sickDays) } : null
    }
    const userRow = levelRows.find(x => x.scopeType === 'user')
    const normView = (kind: AbsenceNormKind): AbsenceNormView => {
      const r = resolved[kind]
      const individual = r.source === 'user' && userRow
      return {
        value: r.value,
        source: r.source,
        setAt: individual ? userRow.updatedAt : null,
        setBy: individual ? userRow.setByName ?? null : null,
        reason: individual ? userRow.reason ?? null : null,
      }
    }

    const rows = await tx.select({ r: absenceRecords, creatorName: users.fullName }).from(absenceRecords)
      .leftJoin(users, eq(users.id, absenceRecords.createdBy))
      .where(and(
        eq(absenceRecords.userId, s.id),
        sql`${absenceRecords.dateFrom} <= make_date(${y}, 12, 31) and ${absenceRecords.dateTo} >= make_date(${y}, 1, 1)`,
      ))
      .orderBy(asc(absenceRecords.dateFrom), asc(absenceRecords.createdAt))
    const records = rows.map(x => toDto(x.r, y, x.creatorName))
    const used = Object.fromEntries(ABSENCE_KINDS.map(k => [k, 0])) as Record<AbsenceKind, number>
    // В остаток входит только подтверждённое (§4, §7.13)
    for (const r of records) if (r.status === 'approved') used[r.kind] += r.daysInYear

    const norms = Object.fromEntries(ABSENCE_NORM_KINDS.map(k => [k, normView(k)])) as Record<AbsenceNormKind, AbsenceNormView>
    const remaining = Object.fromEntries(ABSENCE_NORM_KINDS.map(k => [k, remainingDays(norms[k].value, used[k])])) as Record<AbsenceNormKind, number>

    const [loc] = s.locationId
      ? await tx.execute(sql`select name from locations where id = ${s.locationId}::uuid`) as unknown as { name: string }[]
      : []
    const manage = canManage(viewer, s)
    return {
      ok: true,
      card: {
        year: y,
        person: { id: s.id, locationId: s.locationId, locationName: loc?.name ?? null, archived: s.archived },
        norms,
        levels: { tenant: level('tenant'), location: level('location'), user: level('user') },
        used,
        remaining,
        records,
        missedDeadlines: await missedDeadlines(tx, ctx.tenantId, s.id),
        can: {
          record: manage && !s.archived,
          adjust: {
            tenant: viewer.manage === 'tenant',
            location: !!s.locationId && manage,
            user: manage && !s.archived,
          },
          extend: manage && viewer.extend && !s.archived,
        },
      },
    }
  })
}

/**
 * «Дедлайн минув під час відсутності» (§12): отсутствие внесли задним числом на уже прошедший
 * срок — дедлайн не воскрешается автоматически, руководитель переносит его сам.
 */
async function missedDeadlines(tx: TenantTx, tenantId: string, userId: string): Promise<MissedDeadline[]> {
  const tz = await tenantTimezone(tx, tenantId)
  const rows = await tx.execute(sql`
    select e.id, e.subject_id, e.due_at, a.title, to_char(r.date_from, 'YYYY-MM-DD') as date_from, to_char(r.date_to, 'YYYY-MM-DD') as date_to
    from enrollments e
    join assignments a on a.id = e.assignment_id and a.is_mandatory
    cross join lateral (select ${personTz(sql`e.user_id`, tz)} as tz) z
    join absence_records r on r.user_id = e.user_id and r.status in ('planned', 'approved')
      and (e.due_at at time zone z.tz)::date between r.date_from and r.date_to
    where e.user_id = ${userId}::uuid and e.cancelled_at is null and e.due_at is not null and e.due_at <= now()
      and (e.status in ('not_started', 'in_progress') or (e.status = 'failed' and e.expired_at is not null))
    order by e.due_at desc
    limit 20`) as unknown as { id: string, subject_id: string, due_at: string, title: string, date_from: string, date_to: string }[]
  const out: MissedDeadline[] = []
  const stageAllows = await deadlineCapability(tx)
  for (const r of rows) {
    // Записи, внесённые мимо сервиса и его проверки пересечений, могут перекрываться — срок один раз
    if (out.some(m => m.enrollmentId === r.id) || !(await stageAllows(r.subject_id))) continue
    out.push({ enrollmentId: r.id, title: r.title, dueAt: new Date(r.due_at), absence: { dateFrom: r.date_from, dateTo: r.date_to } })
  }
  return out
}

/**
 * Разрешает ли этап курса срок в назначении — **только** `stageCan(stage, 'deadline')` (`33`
 * §3.3, инвариант 16): у этапа «без сроков» сдвигать нечего. Курс без этапа — полный набор
 * возможностей (`33` §7.3). Кэш на один проход.
 */
async function deadlineCapability(tx: TenantTx): Promise<(courseId: string) => Promise<boolean>> {
  const cache = new Map<string, boolean>()
  return async (courseId: string) => {
    let v = cache.get(courseId)
    if (v === undefined) {
      v = stageCan(await subjectStage(tx, 'course', courseId), 'deadline')
      cache.set(courseId, v)
    }
    return v
  }
}

// ── Внести и поправить запись (§6.4, §10) ────────────────────────────────────────────────

export type AbsenceWriteError
  = | { ok: false, code: 'not_found' | 'forbidden' | 'person_archived' | 'absence_cancelled' }
    | { ok: false, code: 'absence_record.range_invalid', reason: AbsenceRangeError }
    | { ok: false, code: 'absence_overlap', conflict: DateRange & { id: string } }
    | { ok: false, code: 'absence_status_invalid', from: AbsenceStatus, to: AbsenceStatus }

export type AbsenceWriteResult = { ok: true, record: AbsenceRecordDto, shifted: number } | AbsenceWriteError

/** Пересечения записей одного человека проверяются под блокировкой человека — две параллельные вставки не пройдут обе. */
async function lockPerson(tx: TenantTx, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`absence_records:${userId}`}))`)
}

async function findOverlap(tx: TenantTx, userId: string, range: DateRange, excludeId?: string): Promise<(DateRange & { id: string }) | null> {
  const rows = await tx.select({ id: absenceRecords.id, dateFrom: absenceRecords.dateFrom, dateTo: absenceRecords.dateTo }).from(absenceRecords)
    .where(and(
      eq(absenceRecords.userId, userId),
      inArray(absenceRecords.status, ['planned', 'approved']),
      excludeId ? ne(absenceRecords.id, excludeId) : undefined,
      sql`${absenceRecords.dateFrom} <= ${range.dateTo}::date and ${absenceRecords.dateTo} >= ${range.dateFrom}::date`,
    ))
    .orderBy(asc(absenceRecords.dateFrom))
    .limit(1)
  const hit = rows.find(r => rangesOverlap(r, range))
  return hit ?? null
}

async function creatorName(tx: TenantTx, id: string | null): Promise<string | null> {
  if (!id) return null
  const [u] = await tx.select({ name: users.fullName }).from(users).where(eq(users.id, id))
  return u?.name ?? null
}

export async function createAbsenceRecord(ctx: Ctx, viewer: AbsenceViewer, personId: string, input: AbsenceRecordCreate): Promise<AbsenceWriteResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const s = await cardSubject(tx, personId)
    if (!s) return { ok: false, code: 'not_found' }
    if (!canManage(viewer, s)) return { ok: false, code: 'forbidden' }
    if (s.archived) return { ok: false, code: 'person_archived' }
    const rangeError = validateAbsenceRange(input.dateFrom, input.dateTo)
    if (rangeError) return { ok: false, code: 'absence_record.range_invalid', reason: rangeError }

    await lockPerson(tx, s.id)
    const conflict = await findOverlap(tx, s.id, input)
    if (conflict) return { ok: false, code: 'absence_overlap', conflict }

    const source: AbsenceSource = viewer.viaToken ? 'api' : 'manual'
    const [row] = await tx.insert(absenceRecords).values({
      tenantId: ctx.tenantId,
      userId: s.id,
      kind: input.kind,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      daysCount: String(absenceDays(input.dateFrom, input.dateTo)),
      status: input.status,
      source,
      comment: input.comment || null,
      createdBy: ctx.actorId,
    }).returning()
    await recordAudit(tx, {
      tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'absence_record.create', entity: 'absence_record', entityId: row!.id,
      after: { userId: s.id, kind: input.kind, dateFrom: input.dateFrom, dateTo: input.dateTo, status: input.status, source },
    })
    // Отсутствие блокирует дедлайны с момента внесения, не дожидаясь ночного прохода (§7.14)
    const shifted = await shiftDeadlinesForAbsences(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId }, { userIds: [s.id], trigger: 'absence' })
    const year = Number(input.dateFrom.slice(0, 4))
    return { ok: true, record: toDto(row!, year, await creatorName(tx, ctx.actorId)), shifted: shifted.length }
  })
}

export async function updateAbsenceRecord(ctx: Ctx, viewer: AbsenceViewer, personId: string, recordId: string, input: AbsenceRecordUpdate): Promise<AbsenceWriteResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const s = await cardSubject(tx, personId)
    if (!s || !isUuid(recordId)) return { ok: false, code: 'not_found' }
    if (!canManage(viewer, s)) return { ok: false, code: 'forbidden' }
    if (s.archived) return { ok: false, code: 'person_archived' }

    await lockPerson(tx, s.id)
    const [cur] = await tx.select().from(absenceRecords).where(and(eq(absenceRecords.id, recordId), eq(absenceRecords.userId, s.id)))
    if (!cur) return { ok: false, code: 'not_found' }
    const from = cur.status as AbsenceStatus
    if (from === 'cancelled') return { ok: false, code: 'absence_cancelled' }
    const status = input.status ?? from
    if (!absenceTransitionAllowed(from, status)) return { ok: false, code: 'absence_status_invalid', from, to: status }

    const next = {
      kind: input.kind ?? cur.kind as AbsenceKind,
      dateFrom: input.dateFrom ?? cur.dateFrom,
      dateTo: input.dateTo ?? cur.dateTo,
      comment: input.comment !== undefined ? input.comment || null : cur.comment,
    }
    const rangeError = validateAbsenceRange(next.dateFrom, next.dateTo)
    if (rangeError) return { ok: false, code: 'absence_record.range_invalid', reason: rangeError }
    if (status !== 'cancelled') {
      const conflict = await findOverlap(tx, s.id, next, cur.id)
      if (conflict) return { ok: false, code: 'absence_overlap', conflict }
    }

    const [row] = await tx.update(absenceRecords).set({
      ...next,
      daysCount: String(absenceDays(next.dateFrom, next.dateTo)),
      status,
      updatedAt: new Date(),
    }).where(eq(absenceRecords.id, cur.id)).returning()
    await recordAudit(tx, {
      tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'absence_record.update', entity: 'absence_record', entityId: cur.id,
      before: { kind: cur.kind, dateFrom: cur.dateFrom, dateTo: cur.dateTo, status: cur.status, comment: cur.comment },
      after: { userId: s.id, kind: next.kind, dateFrom: next.dateFrom, dateTo: next.dateTo, status, comment: next.comment },
    })
    // Отменённое отсутствие дедлайн назад не двигает `[решение]` (`38` §7.14 [дополнено, PR-33]):
    // сдвинутый срок только дал человеку время, а молча отнятый — дал бы ложное «прострочено»
    const shifted = status === 'cancelled' ? [] : await shiftDeadlinesForAbsences(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId }, { userIds: [s.id], trigger: 'absence' })
    return { ok: true, record: toDto(row!, Number(next.dateFrom.slice(0, 4)), await creatorName(tx, row!.createdBy)), shifted: shifted.length }
  })
}

// ── Планировщик: сдвиг дедлайнов (§7.14, §11 `absence.deadline_guard`) ───────────────────

export interface ShiftedDeadline {
  enrollmentId: string
  userId: string
  from: Date
  to: Date
  startsAt: Date | null
}

export interface GuardScope {
  userIds?: string[]
  enrollmentIds?: string[]
  /** Что запустило проход — пишется в журнал: создание назначения, запись отсутствия, ночной проход. */
  trigger?: 'assignment' | 'absence' | 'daily'
  now?: Date
}

interface Candidate {
  id: string
  user_id: string
  full_name: string
  subject_id: string
  status: string
  title: string
  due_mode: string
  due_days: number | null
  due_at: string
  starts_at: string | null
  tz: string
  due_local: IsoDate
  start_local: IsoDate
  last_day: IsoDate | null
}

/**
 * Сдвиг сроков записей на курс обязательных назначений с дней отсутствия (§7.14). Идемпотентен:
 * сдвинутый срок отсутствием уже не покрыт, повторный проход его не тронет.
 *
 * Берутся записи: назначение `is_mandatory`, не начатые или в процессе, не снятые, срок в
 * будущем (правило работает только вперёд, §12), местная дата срока покрыта отсутствием
 * `planned`/`approved` (§4). Этап курса без возможности `deadline` — пропуск (`stageCan()`).
 * Срок не уезжает за последний рабочий день открытого офбординга `[решение]`: после него человек
 * не работает, а курс офбординга обязан быть пройден до ухода.
 */
export async function shiftDeadlinesForAbsences(tx: TenantTx, ctx: { tenantId: string, actorId: string | null }, scope: GuardScope = {}): Promise<ShiftedDeadline[]> {
  const now = scope.now ?? new Date()
  if (scope.userIds && !scope.userIds.length) return []
  if (scope.enrollmentIds && !scope.enrollmentIds.length) return []
  const tenantTz = await tenantTimezone(tx, ctx.tenantId)
  const only = [
    scope.userIds ? sql`and e.user_id in (${sql.join(scope.userIds.map(id => sql`${id}::uuid`), sql`, `)})` : sql``,
    scope.enrollmentIds ? sql`and e.id in (${sql.join(scope.enrollmentIds.map(id => sql`${id}::uuid`), sql`, `)})` : sql``,
  ]
  const candidates = await tx.execute(sql`
    select e.id, e.user_id, u.full_name, e.subject_id, e.status, a.title, a.due_mode, a.due_days, e.due_at, e.starts_at, z.tz,
      to_char((e.due_at at time zone z.tz)::date, 'YYYY-MM-DD') as due_local,
      to_char((coalesce(e.starts_at, e.created_at) at time zone z.tz)::date, 'YYYY-MM-DD') as start_local,
      (select to_char(oc.last_working_day, 'YYYY-MM-DD') from offboarding_cases oc
        where oc.user_id = e.user_id and oc.state not in ('done', 'cancelled') limit 1) as last_day
    from enrollments e
    join assignments a on a.id = e.assignment_id and a.is_mandatory
    join users u on u.id = e.user_id
    cross join lateral (select ${personTz(sql`e.user_id`, tenantTz)} as tz) z
    where e.status in ('not_started', 'in_progress') and e.cancelled_at is null
      and e.due_at is not null and e.due_at > ${now.toISOString()}::timestamptz
      -- Сначала люди с действующими и будущими отсутствиями (их мало), потом их записи
      and e.user_id in (select r.user_id from absence_records r where r.status in ('planned', 'approved')
        and r.date_to >= (${now.toISOString()}::timestamptz - interval '1 day')::date)
      and exists (select 1 from absence_records r where r.user_id = e.user_id and r.status in ('planned', 'approved')
        and (e.due_at at time zone z.tz)::date between r.date_from and r.date_to)
      ${only[0]} ${only[1]}
    order by e.user_id, e.due_at
    -- Параллельный проход (ночной и запись отсутствия) ждёт строку и перепроверяет условие по
    -- новой версии: сдвинутый срок отсутствием уже не покрыт — второго сдвига и журнала не будет
    for update of e`) as unknown as Candidate[]
  if (!candidates.length) return []

  const stageAllows = await deadlineCapability(tx)
  const absencesOf = new Map<string, DateRange[]>()
  const out: ShiftedDeadline[] = []
  for (const c of candidates) {
    if (!(await stageAllows(c.subject_id))) continue
    let ranges = absencesOf.get(c.user_id)
    if (!ranges) {
      ranges = (await tx.select({ dateFrom: absenceRecords.dateFrom, dateTo: absenceRecords.dateTo }).from(absenceRecords)
        .where(and(eq(absenceRecords.userId, c.user_id), inArray(absenceRecords.status, ['planned', 'approved']))))
      absencesOf.set(c.user_id, ranges)
    }
    const plan = planAroundAbsences({
      due: c.due_local,
      start: c.start_local,
      movableStart: c.status === 'not_started',
      relativeDays: c.due_mode === 'relative' && c.due_days ? c.due_days : null,
      absences: ranges,
    })
    if (!plan) continue
    if (c.last_day && plan.due > c.last_day) continue

    // Новый срок — та же местная минута в новый день; старт — начало местного дня возвращения
    const [after] = await tx.execute(sql`
      update enrollments set
        due_at = ((${plan.due}::date + (due_at at time zone ${c.tz})::time) at time zone ${c.tz}),
        starts_at = ${plan.start ? sql`(${plan.start}::date::timestamp at time zone ${c.tz})` : sql`starts_at`},
        deadline_shifted_reason = 'absence',
        updated_at = now()
      where id = ${c.id}::uuid
      returning due_at, starts_at`) as unknown as { due_at: string, starts_at: string | null }[]
    if (!after) continue
    const from = new Date(c.due_at)
    const to = new Date(after.due_at)
    const startsAt = after.starts_at ? new Date(after.starts_at) : null
    const startMoved = !!plan.start

    await tx.insert(enrollmentEvents).values({
      tenantId: ctx.tenantId,
      enrollmentId: c.id,
      event: 'extended',
      payload: { from, to, reason: 'absence', trigger: scope.trigger ?? 'daily', ...(startMoved ? { startsFrom: c.starts_at, startsTo: startsAt } : {}) },
      actorId: ctx.actorId,
      requestContext: currentRequestContext(),
    })
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'enrollment.deadline_shifted',
      entity: 'enrollment',
      entityId: c.id,
      before: { dueAt: from, startsAt: c.starts_at },
      after: { dueAt: to, startsAt: startMoved ? startsAt : c.starts_at, reason: 'absence', userId: c.user_id, trigger: scope.trigger ?? 'daily' },
    })
    await notifyShift(tx, ctx.tenantId, c, to, plan.due)
    out.push({ enrollmentId: c.id, userId: c.user_id, from, to, startsAt })
  }
  return out
}

/** `absence_deadline_shifted` (§8): человеку — со ссылкой на запись, руководителю — с именем и ссылкой на карточку. */
async function notifyShift(tx: TenantTx, tenantId: string, c: Candidate, to: Date, dueLocal: IsoDate): Promise<void> {
  await enqueueNotification(tx, {
    tenantId,
    userId: c.user_id,
    code: 'absence_deadline_shifted',
    payload: { course: c.title, date: to.toISOString(), self: true, enrollmentId: c.id },
    dedupKey: `absence_deadline_shifted:${c.id}:${dueLocal}:${c.user_id}`,
    refType: 'enrollment',
    refId: c.id,
  })
  // Руководитель — единственным источником истины (`resolveManager()`, П-16.4)
  const manager = await managerIdOf(tx, c.user_id)
  if (manager && manager !== c.user_id) {
    await enqueueNotification(tx, {
      tenantId,
      userId: manager,
      code: 'absence_deadline_shifted',
      payload: { course: c.title, date: to.toISOString(), person: c.full_name, url: `/admin/people/${c.user_id}?tab=absences` },
      dedupKey: `absence_deadline_shifted:${c.id}:${dueLocal}:${manager}`,
    })
  }
}

/** `absence.deadline_guard` (§11): ежесуточно — отсутствия, внесённые после создания назначения. */
export async function absenceDeadlineGuardTenant(tenantId: string, now = new Date()): Promise<number> {
  return withTenant(tenantId, null, async tx => (await shiftDeadlinesForAbsences(tx, { tenantId, actorId: null }, { trigger: 'daily', now })).length)
}

// ── Тишина напоминаний (§7.12, §7.14; §13 к. 10) ─────────────────────────────────────────

/**
 * Кто из людей отсутствует на свою местную дату момента `now`: запись `planned` или
 * `approved` (§4 — «в блокировку дедлайнов … planned и approved»). Напоминания о сроках
 * обучения таким людям в этот день не уходят (§7.14).
 */
export async function peopleAbsentOn(tx: TenantTx, tenantId: string, now = new Date(), userIds?: string[]): Promise<Set<string>> {
  if (userIds && !userIds.length) return new Set()
  const tenantTz = await tenantTimezone(tx, tenantId)
  const rows = await tx.execute(sql`
    select distinct r.user_id from absence_records r
    cross join lateral (select ${personTz(sql`r.user_id`, tenantTz)} as tz) z
    where r.status in ('planned', 'approved')
      -- Грубое окно ±1 день по UTC (частичный индекс по датам) — пояса людей в него укладываются
      and r.date_from <= (${now.toISOString()}::timestamptz + interval '1 day')::date
      and r.date_to >= (${now.toISOString()}::timestamptz - interval '1 day')::date
      and (${now.toISOString()}::timestamptz at time zone z.tz)::date between r.date_from and r.date_to
      ${userIds ? sql`and r.user_id in (${sql.join(userIds.map(id => sql`${id}::uuid`), sql`, `)})` : sql``}`) as unknown as { user_id: string }[]
  return new Set(rows.map(r => r.user_id))
}
