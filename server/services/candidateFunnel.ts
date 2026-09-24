import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { candidateStatusHistory, candidateStatuses, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { keysetAfter, keysetAt } from '../utils/keyset'
import { KEYSETS, encodeKeyset } from '../../shared/domain/keyset'
import { currentRequestContext } from '../utils/requestContext'
import type { CandidateState } from '../../shared/enums'
import type {
  CandidateBoardFilter, CandidateBulkStatusInput, FunnelReportFilter,
} from '../../shared/schemas/candidates'
import { candidateOnly, candidates as candidatesQuery } from './repo/people'
import { COLUMNS, canMove, maskRow, scopeCond } from './candidates'
import type { CandidateRow, Viewer } from './candidates'
import { frameJoins, frameSelect, frameWhere, periodSql } from './reportFrame'
import { recordAudit } from './audit'

/**
 * Воронка: доска (канбан), массовая смена колонки и отчёт
 * (docs/v2/28-recruiting-candidates.md §5.2, §6.3, §9; план docs/v2/45-plan.md PR-14).
 *
 * **Доска не грузит колонку целиком.** 250 карточек в одной колонке — обычное дело на
 * массовом найме, и это первое место, где страница умирает (§5.2). Поэтому каждая колонка
 * отдаёт страницу в 50 карточек, общее число и курсор на следующую; догрузка — отдельным
 * запросом по одной колонке, а не перезагрузкой всей доски (критерий §13 к. 12).
 *
 * **Курсор — по `(created_at, id)`, а не по номеру страницы.** Карточки на доске двигают
 * прямо во время просмотра: смещение `offset` при этом показывает одну и ту же карточку
 * дважды или теряет её. Пара «дата создания + id» уникальна и устойчива к перемещениям,
 * и ровно под неё заведён индекс `idx_users_candidate_board` (миграция 0068).
 *
 * Момент в курсоре — текстом из Postgres с микросекундами (`shared/domain/keyset.ts`). Прежний
 * курсор `<toISOString()>|<id>` резал его до миллисекунд, и «Показати ще» молча теряло все
 * карточки, созданные в ту же миллисекунду, что и последняя показанная.
 */

export interface BoardCard {
  id: string
  fullName: string
  phone: string | null
  email: string | null
  statusId: string | null
  state: CandidateState
  source: string | null
  recruiterId: string | null
  recruiterName: string | null
  accessUntil: string | null
  /** Дней в текущей колонке — от последней записи истории (§7.11), не от создания. */
  daysInStatus: number | null
  /** Три оценки компактно (§5.2): действующие значения видов `manual`, `task`, `recruiter`. */
  scores: Record<string, string | null>
  createdAt: Date
}

export interface BoardColumn {
  statusId: string
  code: string
  nameUk: string
  nameEn: string | null
  color: string
  mapsTo: CandidateState
  total: number
  cards: BoardCard[]
  /** Курсор следующей страницы или `null`, если колонка показана целиком. */
  nextCursor: string | null
}

const CARD = {
  id: users.id,
  fullName: users.fullName,
  phone: users.phone,
  email: users.email,
  statusId: users.candidateStatusId,
  state: users.candidateState,
  source: users.source,
  recruiterId: users.recruiterId,
  accessUntil: users.accessUntil,
  createdAt: users.createdAt,
  // Позиция карточки для курсора — текстом из базы, с микросекундами; наружу не отдаётся.
  cursorAt: keysetAt(users.createdAt),
  recruiterName: sql<string | null>`(select u2.full_name from users u2 where u2.id = ${users.recruiterId})`,
  // «Днів у статусі» — от последней записи истории (§7.11). Подзапрос, а не соединение:
  // карточек на странице полсотни, а соединение с историей дало бы дубли строк.
  statusSince: sql<Date | null>`(select max(h.created_at) from candidate_status_history h where h.candidate_id = ${users.id})`,
  scoreManual: sql<string | null>`(select s.value_num::text from candidate_scores s where s.candidate_id = ${users.id} and s.kind = 'manual' and s.is_current)`,
  scoreTask: sql<string | null>`(select s.value_num::text from candidate_scores s where s.candidate_id = ${users.id} and s.kind = 'task' and s.is_current)`,
  scoreRecruiter: sql<string | null>`(select s.value_num::text from candidate_scores s where s.candidate_id = ${users.id} and s.kind = 'recruiter' and s.is_current)`,
}

type CardRow = {
  id: string
  fullName: string
  phone: string | null
  email: string | null
  statusId: string | null
  state: CandidateState
  source: string | null
  recruiterId: string | null
  recruiterName: string | null
  accessUntil: string | null
  createdAt: Date
  cursorAt: string
  statusSince: Date | null
  scoreManual: string | null
  scoreTask: string | null
  scoreRecruiter: string | null
}

/** Курсор следующей страницы колонки — позиция последней показанной карточки, либо `null`. */
function columnCursor(rows: CardRow[], limit: number): string | null {
  const last = rows.length > limit ? rows[limit - 1] : undefined
  return last ? encodeKeyset(KEYSETS.candidateBoard, [last.cursorAt, last.id]) : null
}

function toCard(v: Viewer, r: CardRow): BoardCard {
  const masked = maskRow(v, r)
  return {
    id: r.id,
    fullName: r.fullName,
    phone: masked.phone,
    email: masked.email,
    statusId: r.statusId,
    state: r.state,
    source: r.source,
    recruiterId: r.recruiterId,
    recruiterName: r.recruiterName,
    accessUntil: r.accessUntil,
    daysInStatus: r.statusSince ? Math.max(0, Math.floor((Date.now() - new Date(r.statusSince).getTime()) / 86_400_000)) : null,
    scores: { manual: r.scoreManual, task: r.scoreTask, recruiter: r.scoreRecruiter },
    createdAt: r.createdAt,
  }
}

function boardFilters(v: Viewer, f: CandidateBoardFilter) {
  const q = f.q?.trim()
  return [
    scopeCond(v),
    eq(users.candidateState, 'active' as CandidateState),
    f.recruiterId ? eq(users.recruiterId, f.recruiterId) : undefined,
    f.source ? eq(users.source, f.source) : undefined,
    q ? or(sql`${users.fullName} ilike ${`%${q}%`}`, sql`${users.phone} ilike ${`%${q}%`}`, sql`${users.email} ilike ${`%${q}%`}`) : undefined,
  ]
}

/**
 * Страница одной колонки (§5.2, §10 `GET /candidates/board?statusId=…`). Ровно этот запрос
 * зовёт кнопка «Показати ще»: он не знает про остальные колонки и не пересчитывает их.
 */
export async function boardColumn(v: Viewer, statusId: string, f: CandidateBoardFilter): Promise<{ cards: BoardCard[], nextCursor: string | null, total: number } | null> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const [status] = await tx.select({ id: candidateStatuses.id }).from(candidateStatuses).where(eq(candidateStatuses.id, statusId))
    if (!status) return null
    const conds = [
      ...boardFilters(v, f),
      eq(users.candidateStatusId, statusId),
      // Курсор по паре (created_at, id): строгий лексикографический «меньше» при сортировке desc.
      keysetAfter(KEYSETS.candidateBoard, f.cursor, [users.createdAt, users.id], 'desc'),
    ]
    const rows = await candidatesQuery(tx, CARD, ...conds)
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(f.limit + 1) as unknown as CardRow[]
    const [count] = await candidatesQuery(tx, { n: sql<number>`count(*)::int` }, ...boardFilters(v, f), eq(users.candidateStatusId, statusId)) as unknown as { n: number }[]
    return {
      cards: rows.slice(0, f.limit).map(r => toCard(v, r)),
      nextCursor: columnCursor(rows, f.limit),
      total: Number(count?.n ?? 0),
    }
  })
}

/**
 * Доска целиком: активные колонки по `sort`, в каждой — первая страница и общее число (§5.2).
 * Колонки с `maps_to <> 'active'` на доске тоже есть (в «Відхилені» карточка попадает после
 * отказа), но карточки в них не грузятся: доска показывает работу, а не архив — там стоит
 * только счётчик, а состав открывается списком с фильтром по состоянию.
 */
export async function board(v: Viewer, f: CandidateBoardFilter): Promise<BoardColumn[]> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const statuses = await tx.select().from(candidateStatuses)
      .where(eq(candidateStatuses.isActive, true))
      .orderBy(candidateStatuses.sort)

    const out: BoardColumn[] = []
    for (const s of statuses) {
      const conds = [...boardFilters(v, f), eq(users.candidateStatusId, s.id)]
      const [count] = await candidatesQuery(tx, { n: sql<number>`count(*)::int` }, ...conds) as unknown as { n: number }[]
      const total = Number(count?.n ?? 0)
      const rows = s.mapsTo === 'active'
        ? await candidatesQuery(tx, CARD, ...conds).orderBy(desc(users.createdAt), desc(users.id)).limit(f.limit + 1) as unknown as CardRow[]
        : []
      out.push({
        statusId: s.id,
        code: s.code,
        nameUk: s.nameUk,
        nameEn: s.nameEn,
        color: s.color,
        mapsTo: s.mapsTo as CandidateState,
        total,
        cards: rows.slice(0, f.limit).map(r => toCard(v, r)),
        nextCursor: columnCursor(rows, f.limit),
      })
    }
    return out
  })
}

// ── Массовая смена колонки (§6.3) ──────────────────────────────────────────────────────────

export type BulkResult =
  | { ok: true, changed: number, skipped: { id: string, reason: string }[] }
  | { ok: false, code: 'status_not_found' }

/**
 * Перенос пачки карточек в одну колонку (§6.3, §10 `POST /candidates/bulk/status`).
 *
 * Пропущенные возвращаются поимённо: «перенесено 7 із 10» без объяснения, какие три и почему,
 * заставляет рекрутера искать их вручную. Найм пачкой не делается никогда — он меняет вид
 * человека, размещение и два лимита (§7.6), и колонка с `maps_to='hired'` здесь отклоняется
 * так же, как в одиночной смене.
 */
export async function bulkStatus(v: Viewer, input: CandidateBulkStatusInput): Promise<BulkResult> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const [status] = await tx.select().from(candidateStatuses).where(eq(candidateStatuses.id, input.statusId))
    if (!status || !status.isActive) return { ok: false, code: 'status_not_found' }
    const to = status.mapsTo as CandidateState

    const rows = await candidatesQuery(tx, COLUMNS, inArray(users.id, input.ids), scopeCond(v)) as unknown as CandidateRow[]
    const found = new Map(rows.map(r => [r.id, r]))
    const skipped: { id: string, reason: string }[] = []
    const movable: CandidateRow[] = []
    for (const id of input.ids) {
      const row = found.get(id)
      if (!row) { skipped.push({ id, reason: 'not_found' }); continue }
      if (row.statusId === status.id) { skipped.push({ id, reason: 'same' }); continue }
      if (to === 'hired') { skipped.push({ id, reason: 'hire_is_not_bulk' }); continue }
      if (!canMove(row.state, to)) { skipped.push({ id, reason: 'not_allowed' }); continue }
      if (to === 'rejected' && !input.reasonCode && !input.reasonText) { skipped.push({ id, reason: 'reason_required' }); continue }
      movable.push(row)
    }
    if (!movable.length) return { ok: true, changed: 0, skipped }

    await tx.update(users).set({
      candidateStatusId: status.id,
      candidateState: to,
      candidateStateAt: new Date(),
      updatedAt: new Date(),
    }).where(and(inArray(users.id, movable.map(r => r.id)), candidateOnly()))

    await tx.insert(candidateStatusHistory).values(movable.map(r => ({
      tenantId: v.tenantId,
      candidateId: r.id,
      fromStatusId: r.statusId,
      toStatusId: status.id,
      reasonCode: input.reasonCode ?? null,
      reasonText: input.reasonText ?? null,
      actorId: v.actorId,
      isAutomatic: false,
      requestContext: currentRequestContext(),
    })))

    await recordAudit(tx, {
      tenantId: v.tenantId,
      actorId: v.actorId,
      action: 'candidate.bulk_status',
      entity: 'user',
      entityId: null,
      after: { ids: movable.map(r => r.id), statusId: status.id, state: to, reasonCode: input.reasonCode ?? null },
    })
    return { ok: true, changed: movable.length, skipped }
  })
}

// ── Отчёт по воронке (§9 п. 1, единый каркас колонок docs/22 §13) ──────────────────────────

export interface FunnelStage {
  statusId: string
  code: string
  nameUk: string
  mapsTo: CandidateState
  /** Сколько кандидатов побывало в колонке за период (по истории, а не по текущему месту). */
  entered: number
  /** Сколько стоит в ней сейчас. */
  current: number
  /** Доля от вошедших в воронку за период. */
  sharePct: number
  /** Среднее время в колонке, дней. */
  avgDays: number | null
  /** Конверсия в следующую колонку: доля вошедших, которые пошли дальше. */
  toNextPct: number | null
}

export interface FunnelSummary {
  entered: number
  hired: number
  rejected: number
  archived: number
  withdrawn: number
  active: number
  /** Медиана «дней до найма» по нанятым за период (§9 п. 4). */
  medianDaysToHire: number | null
}

export interface FunnelReport {
  stages: FunnelStage[]
  summary: FunnelSummary
  /** Люди единым каркасом колонок (docs/22 §13.3): ПІБ · посада · місто · підрозділ · мітки · … */
  rows: Record<string, unknown>[]
}

/**
 * Отчёт по воронке (§9 п. 1) плюс сводка §9 п. 4 и список людей единым каркасом (docs/22 §13.3).
 *
 * Два слоя в одном отчёте — не прихоть: агрегат отвечает «где теряем», список отвечает «кто
 * именно», и рекрутеру нужны оба, иначе он строит второй отчёт руками. Левая часть списка —
 * тот же каркас, что у всех отчётов репозитория, с единственным отличием: вид человека —
 * `candidate` (`reportFrame.frameWhere({ kind })`, П-16.1).
 *
 * Найм считается по `converted_from_candidate_at`, а не по колонке канбана: после найма
 * человек — сотрудник, его `candidate_status_id` снят (§7.6, решение PR-13), и колонки
 * «Найняті» у тенанта может не быть вовсе — она не входит в шесть системных (§3.3).
 */
export async function funnelReport(v: Viewer, f: FunnelReportFilter): Promise<FunnelReport> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const scope = scopeCond(v)
    const recruiter = f.recruiterId ? sql`and u.recruiter_id = ${f.recruiterId}::uuid` : sql``
    const source = f.source ? sql`and u.source = ${f.source}` : sql``
    // Область видимости областной роли (§5.1): до появления `users.vacancy_id` (PR-15) точка
    // кандидата неизвестна, и роль без `candidate.view` на сеть видит только своих.
    const mine = scope ? sql`and u.recruiter_id = ${v.actorId}::uuid` : sql``
    const period = periodSql(sql`u.created_at`, f)

    const statuses = await tx.select().from(candidateStatuses)
      .where(eq(candidateStatuses.isActive, true))
      .orderBy(candidateStatuses.sort)

    const rows = await tx.execute(sql`
      select h.to_status_id as status_id,
             count(distinct h.candidate_id)::int as entered,
             avg(extract(epoch from (coalesce(h.left_at, now()) - h.created_at)) / 86400)::float as avg_days
        from (
          select h.*, lead(h.created_at) over (partition by h.candidate_id order by h.created_at) as left_at
            from candidate_status_history h
        ) h
        join users u on u.id = h.candidate_id
       where u.kind = 'candidate' ${period} ${recruiter} ${source} ${mine}
       group by h.to_status_id`) as unknown as { status_id: string, entered: number, avg_days: number | null }[]
    const byStatus = new Map(rows.map(r => [r.status_id, r]))

    const currentRows = await tx.execute(sql`
      select u.candidate_status_id as status_id, count(*)::int as n
        from users u
       where u.kind = 'candidate' and u.candidate_status_id is not null ${period} ${recruiter} ${source} ${mine}
       group by u.candidate_status_id`) as unknown as { status_id: string, n: number }[]
    const byCurrent = new Map(currentRows.map(r => [r.status_id, Number(r.n)]))

    const [totals] = await tx.execute(sql`
      select count(*)::int as entered,
             count(*) filter (where u.candidate_state = 'active')::int as active,
             count(*) filter (where u.candidate_state = 'rejected')::int as rejected,
             count(*) filter (where u.candidate_state = 'archived')::int as archived,
             count(*) filter (where u.candidate_state = 'withdrawn')::int as withdrawn
        from users u
       where u.kind = 'candidate' ${period} ${recruiter} ${source} ${mine}`) as unknown as { entered: number, active: number, rejected: number, archived: number, withdrawn: number }[]

    // Нанятые за период: они уже сотрудники, и их видно только по дате конверсии (§7.6).
    const [hired] = await tx.execute(sql`
      select count(*)::int as n,
             percentile_cont(0.5) within group (
               order by extract(epoch from (u.converted_from_candidate_at - u.created_at)) / 86400
             )::float as median_days
        from users u
       where u.kind = 'employee' and u.converted_from_candidate_at is not null
         ${periodSql(sql`u.converted_from_candidate_at`, f)} ${recruiter} ${source} ${mine}`) as unknown as { n: number, median_days: number | null }[]

    const enteredTotal = Number(totals?.entered ?? 0) + Number(hired?.n ?? 0)
    const stages: FunnelStage[] = statuses.map((s, i) => {
      const agg = byStatus.get(s.id)
      const entered = Number(agg?.entered ?? 0)
      const next = statuses[i + 1]
      const nextEntered = next ? Number(byStatus.get(next.id)?.entered ?? 0) : null
      return {
        statusId: s.id,
        code: s.code,
        nameUk: s.nameUk,
        mapsTo: s.mapsTo as CandidateState,
        entered,
        current: byCurrent.get(s.id) ?? 0,
        sharePct: enteredTotal ? Math.round((entered / enteredTotal) * 1000) / 10 : 0,
        avgDays: agg?.avg_days == null ? null : Math.round(Number(agg.avg_days) * 10) / 10,
        toNextPct: nextEntered === null || !entered ? null : Math.round((nextEntered / entered) * 1000) / 10,
      }
    })

    const people = await tx.execute(sql`
      select ${frameSelect()},
             u.candidate_state as state, u.source, u.created_at as added_at,
             u.converted_from_candidate_at as hired_at,
             (select s.name_uk from candidate_statuses s where s.id = u.candidate_status_id) as funnel_status,
             (select u2.full_name from users u2 where u2.id = u.recruiter_id) as recruiter
        from users u ${frameJoins()}
       where true ${frameWhere({ kind: 'candidate' })} ${period} ${recruiter} ${source} ${mine}
       order by u.created_at desc
       limit 5000`) as unknown as Record<string, unknown>[]

    return {
      stages,
      summary: {
        entered: enteredTotal,
        hired: Number(hired?.n ?? 0),
        rejected: Number(totals?.rejected ?? 0),
        archived: Number(totals?.archived ?? 0),
        withdrawn: Number(totals?.withdrawn ?? 0),
        active: Number(totals?.active ?? 0),
        medianDaysToHire: hired?.median_days == null ? null : Math.round(Number(hired.median_days) * 10) / 10,
      },
      rows: people,
    }
  })
}
