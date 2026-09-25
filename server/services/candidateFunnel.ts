import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { candidateStatusHistory, candidateStatuses, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { keysetAfter, keysetAt } from '../utils/keyset'
import { KEYSETS, encodeKeyset } from '../../shared/domain/keyset'
import { currentRequestContext } from '../utils/requestContext'
import type { CandidateState } from '../../shared/enums'
import type {
  CandidateBoardFilter, CandidateBulkStatusInput, FunnelReportFilter, RecruitingReportFilter,
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

/**
 * Четыре отчёта пакета `28` §9 п. 2–5 (PR-38, П-22, `⟵` PR-14). Один и тот же кандидатопоток,
 * группировка на сервере — по рекрутеру, джерелу, вакансії/точці или причині відмови. Людина
 * відбирається тим самим каркасом, що й воронка (`frameWhere({kind: 'candidate'})`), тому
 * область видимості й фільтр архіву не розʼїжджаються між чотирма звітами.
 *
 * «Найнято» рахується конверсією `converted_from_candidate_at` (§7.6): після найму людина —
 * співробітник, `recruiter_id`/`source`/`vacancy_id` зберігаються без зміни (той самий факт,
 * що використовує підсумок воронки вище).
 */

/**
 * Мінімальний «глядач» для чотирьох звітів нижче: тільки те, що потрібно для розрізу за
 * рекрутером і області видимості (`locations`). Повний `Viewer` (`fullPd`/`reviewOnly`) тут
 * не потрібен — жоден із чотирьох звітів не показує ПД кандидата, лише агреговані числа й
 * імена рекрутерів, тому їх можна дістати і з конструктора виgrузок (`report.builder`), не
 * тільки з екрана воронки (`candidate.view`).
 */
export interface RecruitingReportViewer { tenantId: string, actorId: string, locations: string[] | null }

interface RecruiterEfficiencyRow {
  recruiterId: string | null
  recruiter: string | null
  added: number
  inProgress: number
  onReview: number
  hired: number
  rejected: number
  archived: number
  avgDaysToDecision: number | null
  hireSharePct: number
}

/**
 * «Ефективність рекрутера» (`28` §9 п. 2). «На перевірці» — кандидати з відкритим елементом
 * єдиної черги перевірки (`review_queue_items.completed_at is null`, `subject_kind = 'candidate'`):
 * інтерв'ю чи тестове чекає рішення проверяющего, а не рекрутера (`docs/v2/37` §3.1).
 */
export async function recruiterEfficiencyReport(v: RecruitingReportViewer, f: RecruitingReportFilter): Promise<RecruiterEfficiencyRow[]> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const mine = v.locations !== null ? sql`and u.recruiter_id = ${v.actorId}::uuid` : sql``
    const source = f.source ? sql`and u.source = ${f.source}` : sql``
    const vacancy = f.vacancyId ? sql`and u.vacancy_id = ${f.vacancyId}::uuid` : sql``
    const recruiterFilter = f.recruiterId ? sql`and u.recruiter_id = ${f.recruiterId}::uuid` : sql``

    const inFlight = await tx.execute(sql`
      select u.recruiter_id,
             count(*)::int as added,
             count(*) filter (where u.candidate_state = 'active')::int as in_progress,
             count(*) filter (where u.candidate_state = 'active' and exists (
               select 1 from review_queue_items rq where rq.user_id = u.id and rq.subject_kind = 'candidate' and rq.completed_at is null
             ))::int as on_review,
             count(*) filter (where u.candidate_state = 'rejected')::int as rejected,
             count(*) filter (where u.candidate_state = 'archived')::int as archived
        from users u
       where true ${frameWhere({ kind: 'candidate' })} ${periodSql(sql`u.created_at`, f)}
             ${source} ${vacancy} ${recruiterFilter} ${mine}
       group by u.recruiter_id`) as unknown as { recruiter_id: string | null, added: number, in_progress: number, on_review: number, rejected: number, archived: number }[]

    const hired = await tx.execute(sql`
      select u.recruiter_id,
             count(*)::int as hired,
             avg(extract(epoch from (u.converted_from_candidate_at - u.created_at)) / 86400)::float as avg_days
        from users u
       where u.kind = 'employee' and u.converted_from_candidate_at is not null
             ${periodSql(sql`u.converted_from_candidate_at`, f)} ${source} ${vacancy} ${recruiterFilter} ${mine}
       group by u.recruiter_id`) as unknown as { recruiter_id: string | null, hired: number, avg_days: number | null }[]

    const ids = [...new Set([...inFlight, ...hired].map(r => r.recruiter_id).filter((x): x is string => !!x))]
    const names = ids.length ? await tx.execute(sql`select id, full_name from users where id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})`) as unknown as { id: string, full_name: string }[] : []
    const nameOf = new Map(names.map(n => [n.id, n.full_name]))
    const byRecruiter = new Map<string | null, RecruiterEfficiencyRow>()
    for (const r of inFlight) {
      byRecruiter.set(r.recruiter_id, {
        recruiterId: r.recruiter_id, recruiter: r.recruiter_id ? nameOf.get(r.recruiter_id) ?? null : null,
        added: Number(r.added), inProgress: Number(r.in_progress), onReview: Number(r.on_review),
        hired: 0, rejected: Number(r.rejected), archived: Number(r.archived), avgDaysToDecision: null, hireSharePct: 0,
      })
    }
    for (const r of hired) {
      const row = byRecruiter.get(r.recruiter_id) ?? {
        recruiterId: r.recruiter_id, recruiter: r.recruiter_id ? nameOf.get(r.recruiter_id) ?? null : null,
        added: 0, inProgress: 0, onReview: 0, hired: 0, rejected: 0, archived: 0, avgDaysToDecision: null, hireSharePct: 0,
      }
      row.hired = Number(r.hired)
      row.avgDaysToDecision = r.avg_days == null ? null : Math.round(Number(r.avg_days) * 10) / 10
      byRecruiter.set(r.recruiter_id, row)
    }
    return [...byRecruiter.values()].map(r => ({ ...r, hireSharePct: r.added + r.hired ? Math.round((r.hired / (r.added + r.hired)) * 1000) / 10 : 0 }))
      .sort((a, b) => (b.added + b.hired) - (a.added + a.hired))
  })
}

interface SourceRow {
  source: string
  candidates: number
  reachedFinal: number
  hired: number
  avgBudget: number | null
}

/**
 * «Джерела» (`28` §9 п. 3). «Дошло до фіналу» — кандидат хоч раз потрапив у статус з
 * максимальним `sort` серед активних (`maps_to = 'active'`) статусів воронки: він пройшов усі
 * проміжні кроки, а не тільки перший. «Вартість найму» — середній `vacancies.source_budget`
 * серед найнятих цим джерелом, якщо бюджет площадки вказаний у вакансії (`docs/29`); вакансій
 * без бюджету в середнє не входять.
 */
export async function candidateSourcesReport(v: RecruitingReportViewer, f: RecruitingReportFilter): Promise<SourceRow[]> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const mine = v.locations !== null ? sql`and u.recruiter_id = ${v.actorId}::uuid` : sql``
    const recruiterFilter = f.recruiterId ? sql`and u.recruiter_id = ${f.recruiterId}::uuid` : sql``
    const vacancy = f.vacancyId ? sql`and u.vacancy_id = ${f.vacancyId}::uuid` : sql``
    const sourceFilter = f.source ? sql`and u.source = ${f.source}` : sql``
    const finalStatus = sql`(select id from candidate_statuses where maps_to = 'active' and is_active order by sort desc limit 1)`

    const inFlight = await tx.execute(sql`
      select u.source, count(*)::int as candidates,
             count(*) filter (where exists (
               select 1 from candidate_status_history h where h.candidate_id = u.id and h.to_status_id = ${finalStatus}
             ))::int as reached_final
        from users u
       where true ${frameWhere({ kind: 'candidate' })} ${periodSql(sql`u.created_at`, f)}
             ${recruiterFilter} ${vacancy} ${sourceFilter} ${mine}
       group by u.source`) as unknown as { source: string, candidates: number, reached_final: number }[]

    const hired = await tx.execute(sql`
      select u.source, count(*)::int as hired, avg(v.source_budget)::numeric as avg_budget
        from users u left join vacancies v on v.id = u.vacancy_id
       where u.kind = 'employee' and u.converted_from_candidate_at is not null
             ${periodSql(sql`u.converted_from_candidate_at`, f)} ${recruiterFilter} ${vacancy} ${sourceFilter} ${mine}
       group by u.source`) as unknown as { source: string, hired: number, avg_budget: string | null }[]

    const byS = new Map<string, SourceRow>()
    for (const r of inFlight) byS.set(r.source, { source: r.source, candidates: Number(r.candidates), reachedFinal: Number(r.reached_final), hired: 0, avgBudget: null })
    for (const r of hired) {
      const row = byS.get(r.source) ?? { source: r.source, candidates: 0, reachedFinal: 0, hired: 0, avgBudget: null }
      row.hired = Number(r.hired)
      row.avgBudget = r.avg_budget == null ? null : Math.round(Number(r.avg_budget) * 100) / 100
      byS.set(r.source, row)
    }
    return [...byS.values()].sort((a, b) => b.candidates - a.candidates)
  })
}

interface TimeToHireRow {
  vacancyId: string | null
  vacancy: string | null
  location: string | null
  hired: number
  medianDays: number | null
  p90Days: number | null
}

/** «Час до найму» (`28` §9 п. 4): медіана і 90-й перцентиль від створення до `hired`, у розрізі вакансій і точок. */
export async function timeToHireReport(v: RecruitingReportViewer, f: RecruitingReportFilter): Promise<TimeToHireRow[]> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const mine = v.locations !== null ? sql`and u.recruiter_id = ${v.actorId}::uuid` : sql``
    const recruiterFilter = f.recruiterId ? sql`and u.recruiter_id = ${f.recruiterId}::uuid` : sql``
    const vacancy = f.vacancyId ? sql`and u.vacancy_id = ${f.vacancyId}::uuid` : sql``
    const sourceFilter = f.source ? sql`and u.source = ${f.source}` : sql``
    const rows = await tx.execute(sql`
      select u.vacancy_id, v.title as vacancy, l.name as location,
             count(*)::int as hired,
             round((percentile_cont(0.5) within group (order by extract(epoch from (u.converted_from_candidate_at - u.created_at)) / 86400))::numeric, 1) as median_days,
             round((percentile_cont(0.9) within group (order by extract(epoch from (u.converted_from_candidate_at - u.created_at)) / 86400))::numeric, 1) as p90_days
        from users u
        left join vacancies v on v.id = u.vacancy_id
        left join locations l on l.id = v.location_id
       where u.kind = 'employee' and u.converted_from_candidate_at is not null
             ${periodSql(sql`u.converted_from_candidate_at`, f)} ${recruiterFilter} ${vacancy} ${sourceFilter} ${mine}
       group by u.vacancy_id, v.title, l.name
       order by hired desc`) as unknown as { vacancy_id: string | null, vacancy: string | null, location: string | null, hired: number, median_days: string | null, p90_days: string | null }[]
    return rows.map(r => ({
      vacancyId: r.vacancy_id, vacancy: r.vacancy, location: r.location, hired: Number(r.hired),
      medianDays: r.median_days == null ? null : Number(r.median_days), p90Days: r.p90_days == null ? null : Number(r.p90_days),
    }))
  })
}

interface RejectionReasonRow {
  reasonCode: string | null
  vacancy: string | null
  count: number
  sharePct: number
}

/** «Відмови по причинах» (`28` §9 п. 5): причина · число · частка · розріз по вакансіям. */
export async function rejectionReasonsReport(v: RecruitingReportViewer, f: RecruitingReportFilter): Promise<RejectionReasonRow[]> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const mine = v.locations !== null ? sql`and u.recruiter_id = ${v.actorId}::uuid` : sql``
    const recruiterFilter = f.recruiterId ? sql`and u.recruiter_id = ${f.recruiterId}::uuid` : sql``
    const vacancy = f.vacancyId ? sql`and u.vacancy_id = ${f.vacancyId}::uuid` : sql``
    const sourceFilter = f.source ? sql`and u.source = ${f.source}` : sql``
    const rows = await tx.execute(sql`
      select h.reason_code, v.title as vacancy, count(distinct h.candidate_id)::int as n
        from candidate_status_history h
        join users u on u.id = h.candidate_id
        join candidate_statuses s on s.id = h.to_status_id and s.maps_to = 'rejected'
        left join vacancies v on v.id = u.vacancy_id
       where true ${frameWhere({ kind: 'candidate' })} ${periodSql(sql`h.created_at`, f)}
             ${recruiterFilter} ${vacancy} ${sourceFilter} ${mine}
       group by h.reason_code, v.title
       order by n desc`) as unknown as { reason_code: string | null, vacancy: string | null, n: number }[]
    const total = rows.reduce((s, r) => s + Number(r.n), 0)
    return rows.map(r => ({ reasonCode: r.reason_code, vacancy: r.vacancy, count: Number(r.n), sharePct: total ? Math.round((Number(r.n) / total) * 1000) / 10 : 0 }))
  })
}
