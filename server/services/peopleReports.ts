import { sql } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'
import { ABSENCE_DEFAULTS } from '../../shared/schemas/absences'
import type { DocumentsReportQuery, AbsenceNormsReportQuery, ActivityReportQuery } from '../../shared/schemas/personRecords'
import { ABSENCE_NORM_KINDS, type AbsenceNormKind, type PersonDocumentStatus } from '../../shared/enums'
import { daysInYear, remainingDays } from '../../shared/domain/absences'
import { learningActivityReport } from './activity'
import type { NormSource } from './absenceNorms'
import { localDate } from './personDocuments'
import { frameJoins, frameWhere } from './reportFrame'

/**
 * Отчёты карточки человека `docs/v2/38` §9 п. 1–4 (запись `46` «package-criteria-tails», часть 3).
 * Каркас людей у всех трёх — `frameJoins()`/`frameWhere()`: только сотрудники (инвариант 17), без
 * уволенных, область — по **текущей** точке человека, как у «Індексу залученості» (п. 5).
 */

interface Ctx { tenantId: string, actorId: string }

/** Область документов (`38` §2): весь тенант — все типы; точки — только типы `visible_to_manager`. */
export interface DocumentsArea { locations: string[] | null }

export interface DocumentReportRow {
  userId: string
  fullName: string
  position: string | null
  location: string | null
  /** id типа и название; у строки «відсутній» документа нет — `documentId` пуст. */
  documentId: string | null
  typeId: string
  type: string
  /** `null` — обязательного документа нет вовсе (режим «Тільки відсутні обовʼязкові»). */
  status: PersonDocumentStatus | null
  issuedAt: string | null
  expiresAt: string | null
  /** До `expires_at` от «сегодня» по поясу тенанта; отрицательное — просрочен; `null` — бессрочный. */
  daysLeft: number | null
  uploadedBy: string | null
  /** Загрузил сам человек — источник не проверен (§7.8). */
  selfUploaded: boolean
}

async function tenantToday(tx: Parameters<Parameters<typeof withTenant>[2]>[0], tenantId: string): Promise<string> {
  const [t] = await tx.execute(sql`select timezone from tenants where id = ${tenantId}::uuid`) as unknown as { timezone: string | null }[]
  return localDate(new Date(), t?.timezone ?? 'Europe/Kyiv')
}

/**
 * «Документи співробітників» (§9 п. 1) и «Прострочені та близькі до завершення» (п. 2 —
 * `preset='expiring'`: статус зафиксирован `expiring`/`expired`, порядок — по `expires_at`).
 * Без фильтра статуса отменённые не показываются: отчёт о действующих документах, отменённый
 * виден только по явному `status='revoked'` (`44` Р-BT.4). Режим `missingOnly` — строки
 * «человек × обязательный тип без действующего документа» по правилу карточки (`documentRequiredFor`:
 * тип активен, обязателен, посада подходит или список посад пуст).
 */
export async function documentsReport(ctx: Ctx, area: DocumentsArea, f: DocumentsReportQuery): Promise<DocumentReportRow[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const today = await tenantToday(tx, ctx.tenantId)
    const typeVisible = area.locations === null ? sql`` : sql`and t.visible_to_manager`
    const frame = { kind: 'employee' as const, scope: area.locations, positionIds: f.positionId ? [f.positionId] : undefined, q: f.q }
    const narrow = sql`${f.locationId ? sql`and pl.location_id = ${f.locationId}::uuid` : sql``}
      ${f.typeId ? sql`and t.id = ${f.typeId}::uuid` : sql``}
      ${typeVisible}`

    if (f.missingOnly) {
      const rows = await tx.execute(sql`
        select u.id::text as user_id, u.full_name, p.name as position, l.name as location, t.id::text as type_id, t.name as type
          from users u
          ${frameJoins()}
          join person_document_types t on t.is_required and t.is_active
         where (cardinality(t.required_positions) = 0 or exists (
                  select 1 from user_placements up2
                   where up2.user_id = u.id and up2.ended_at is null and up2.position_id = any(t.required_positions)))
           and not exists (select 1 from person_documents d where d.user_id = u.id and d.type_id = t.id and d.status <> 'revoked')
           ${frameWhere(frame)} ${narrow}
         order by u.full_name, u.id, t.name`) as unknown as { user_id: string, full_name: string, position: string | null, location: string | null, type_id: string, type: string }[]
      return rows.map(r => ({
        userId: r.user_id, fullName: r.full_name, position: r.position, location: r.location, documentId: null, typeId: r.type_id, type: r.type,
        status: null, issuedAt: null, expiresAt: null, daysLeft: null, uploadedBy: null, selfUploaded: false,
      }))
    }

    const expiring = f.preset === 'expiring'
    const status = expiring
      ? sql`and d.status in ('expiring', 'expired')`
      : f.status ? sql`and d.status = ${f.status}` : sql`and d.status <> 'revoked'`
    const rows = await tx.execute(sql`
      select u.id::text as user_id, u.full_name, p.name as position, l.name as location,
             d.id::text as document_id, t.id::text as type_id, t.name as type, d.status,
             d.issued_at::text as issued_at, d.expires_at::text as expires_at,
             (d.expires_at - ${today}::date)::int as days_left,
             upl.full_name as uploaded_by, d.uploaded_by = d.user_id as self_uploaded
        from person_documents d
        join person_document_types t on t.id = d.type_id
        join users u on u.id = d.user_id
        ${frameJoins()}
        -- Обогащение именем загрузившего: людей в выборку left join не добавляет
        left join users upl on upl.id = d.uploaded_by
       where true ${status}
         ${f.expiresFrom ? sql`and d.expires_at >= ${f.expiresFrom}::date` : sql``}
         ${f.expiresTo ? sql`and d.expires_at <= ${f.expiresTo}::date` : sql``}
         ${frameWhere(frame)} ${narrow}
       order by ${expiring ? sql`d.expires_at asc nulls last, u.full_name` : sql`u.full_name, u.id, t.name, d.issued_at desc nulls last`}`) as unknown as {
      user_id: string, full_name: string, position: string | null, location: string | null, document_id: string, type_id: string, type: string,
      status: PersonDocumentStatus, issued_at: string | null, expires_at: string | null, days_left: number | null, uploaded_by: string | null, self_uploaded: boolean
    }[]
    return rows.map(r => ({
      userId: r.user_id, fullName: r.full_name, position: r.position, location: r.location, documentId: r.document_id, typeId: r.type_id, type: r.type,
      status: r.status, issuedAt: r.issued_at, expiresAt: r.expires_at, daysLeft: r.days_left, uploadedBy: r.uploaded_by, selfUploaded: r.self_uploaded,
    }))
  })
}

/** Подписи статуса для файла — те же, что `personDocs.status.*` карточки (uk): файл читают вне продукта. */
const DOC_STATUS_UK: Record<PersonDocumentStatus | 'missing', string> = {
  valid: 'Дійсний', expiring: 'Закінчується', expired: 'Прострочено', revoked: 'Відкликано', missing: 'Відсутній',
}

/** Плоские строки выгрузки п. 1–2: колонки §9 п. 1 в порядке документа. */
export function documentsExportRows(rows: DocumentReportRow[]): Record<string, unknown>[] {
  return rows.map(r => ({
    full_name: r.fullName, position: r.position ?? '', location: r.location ?? '', type: r.type,
    status: DOC_STATUS_UK[r.status ?? 'missing'], issued_at: r.issuedAt ?? '', expires_at: r.expiresAt ?? '',
    days_left: r.daysLeft ?? '', uploaded_by: r.uploadedBy ?? '',
  }))
}

export interface AbsenceNormsReportRow {
  userId: string
  fullName: string
  location: string | null
  kind: AbsenceNormKind
  norm: number
  normSource: NormSource
  used: number
  remaining: number
}

/**
 * «Норми і залишки відсутностей» (§9 п. 3): строка — человек × вид с нормой (`ABSENCE_NORM_KINDS`).
 * Норма — то же разрешение, что `resolveAbsenceNorms()` карточки (человек → текущая точка →
 * компания → системный дефолт), использовано — подтверждённые записи пересечением с годом
 * (`daysInYear`), остаток — `remainingDays`: цифры отчёта и блока «Відсутності» совпадают по
 * построению (`44` Р-BT.4). Год — текущий по поясу тенанта, если не задан.
 */
export async function absenceNormsReport(ctx: Ctx, scope: string[] | null, f: AbsenceNormsReportQuery): Promise<AbsenceNormsReportRow[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const year = f.year ?? Number((await tenantToday(tx, ctx.tenantId)).slice(0, 4))
    const people = await tx.execute(sql`
      select u.id::text as user_id, u.full_name, pl.location_id::text as location_id, l.name as location
        from users u
        ${frameJoins()}
       where true ${frameWhere({ kind: 'employee', scope, q: f.q })}
         ${f.locationId ? sql`and pl.location_id = ${f.locationId}::uuid` : sql``}
       order by u.full_name, u.id`) as unknown as { user_id: string, full_name: string, location_id: string | null, location: string | null }[]
    if (!people.length) return []

    const norms = await tx.execute(sql`
      select scope_type, scope_id::text as scope_id, vacation_days::float8 as vacation, sick_days::float8 as sick
        from absence_norms where year = ${year}::int`) as unknown as { scope_type: 'tenant' | 'location' | 'user', scope_id: string | null, vacation: number | null, sick: number | null }[]
    const level = new Map(norms.map(n => [`${n.scope_type}:${n.scope_id ?? ''}`, n]))
    const records = await tx.execute(sql`
      select user_id::text as user_id, kind, date_from::text as date_from, date_to::text as date_to
        from absence_records
       where status = 'approved' and kind in ('vacation', 'sick')
         and date_from <= make_date(${year}::int, 12, 31) and date_to >= make_date(${year}::int, 1, 1)
         and user_id in (${sql.join(people.map(p => sql`${p.user_id}::uuid`), sql`, `)})`) as unknown as { user_id: string, kind: AbsenceNormKind, date_from: string, date_to: string }[]
    const used = new Map<string, number>()
    for (const r of records) used.set(`${r.user_id}:${r.kind}`, (used.get(`${r.user_id}:${r.kind}`) ?? 0) + daysInYear(r.date_from, r.date_to, year))

    const out: AbsenceNormsReportRow[] = []
    for (const p of people) {
      for (const kind of ABSENCE_NORM_KINDS) {
        const field = kind === 'vacation' ? 'vacation' : 'sick'
        let norm: number = kind === 'vacation' ? ABSENCE_DEFAULTS.vacationDays : ABSENCE_DEFAULTS.sickDays
        let source: NormSource = 'system'
        for (const [scope, id] of [['user', p.user_id], ['location', p.location_id ?? '-'], ['tenant', '']] as const) {
          const v = level.get(`${scope}:${id}`)?.[field]
          if (v !== null && v !== undefined) {
            norm = Number(v)
            source = scope
            break
          }
        }
        const u = used.get(`${p.user_id}:${kind}`) ?? 0
        const remaining = remainingDays(norm, u)
        if (f.negativeOnly && remaining >= 0) continue
        out.push({ userId: p.user_id, fullName: p.full_name, location: p.location, kind, norm, normSource: source, used: u, remaining })
      }
    }
    return out
  })
}

const KIND_UK: Record<AbsenceNormKind, string> = { vacation: 'Відпустка', sick: 'Лікарняний' }
const SOURCE_UK: Record<NormSource, string> = { user: 'Індивідуально', location: 'Норма точки', tenant: 'Норма компанії', system: 'Норма системи' }

export function absenceNormsExportRows(rows: AbsenceNormsReportRow[]): Record<string, unknown>[] {
  return rows.map(r => ({
    full_name: r.fullName, location: r.location ?? '', kind: KIND_UK[r.kind], norm: r.norm,
    norm_source: SOURCE_UK[r.normSource], used: r.used, remaining: r.remaining,
  }))
}

export interface ActivityReportRow {
  userId: string
  fullName: string
  location: string | null
  daysActive: number
  longestStreak: number
  totalEvents: number
  hours: number
}

/**
 * «Навчальна активність» (§9 п. 4) — тот же расчёт, что у готового отчёта конструктора
 * (`learningActivityReport`, PR-38): ни второй копии серии, ни второй формулы часов. Фильтр точки
 * сужает область смотрящего, а не расширяет её: точка вне области — пустой отчёт.
 */
export async function activityReport(ctx: Ctx, scope: string[] | null, f: ActivityReportQuery): Promise<ActivityReportRow[]> {
  const narrowed = f.locationId ? (scope === null || scope.includes(f.locationId) ? [f.locationId] : []) : scope
  const rows = await learningActivityReport({ ...ctx, scope: narrowed }, { from: f.from, to: f.to, q: f.q })
  return (rows as { user_id: string, full_name: string, location: string | null, days_active: number, longest_streak: number, total_events: number, hours: number | string }[])
    .map(r => ({
      userId: r.user_id, fullName: r.full_name, location: r.location, daysActive: Number(r.days_active),
      longestStreak: Number(r.longest_streak), totalEvents: Number(r.total_events), hours: Number(r.hours),
    }))
}

export function activityExportRows(rows: ActivityReportRow[]): Record<string, unknown>[] {
  return rows.map(r => ({
    full_name: r.fullName, location: r.location ?? '', days_active: r.daysActive, longest_streak: r.longestStreak,
    total_events: r.totalEvents, hours: r.hours,
  }))
}
