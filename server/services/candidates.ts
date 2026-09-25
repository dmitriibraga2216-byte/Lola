import { and, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm'
import {
  candidateComments, candidateScores, candidateStatusHistory, candidateStatuses, users,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'
import { CANDIDATE_CONSENT_MONTHS } from '../../shared/enums'
import type { CandidateScoreKind, CandidateState } from '../../shared/enums'
import type {
  CandidateCommentInput, CandidateCreateInput, CandidateListFilter, CandidateScoreInput,
  CandidateStatusMoveInput, CandidateUpdateInput,
} from '../../shared/schemas/candidates'
import { candidateOnly, candidates as candidatesQuery, personById } from './repo/people'
import { recordAudit } from './audit'
import { splitName } from './people'

/**
 * Кандидат: карточка, статусы, оценки, комментарии (docs/v2/28-recruiting-candidates.md §3–§7,
 * план docs/v2/45-plan.md PR-13).
 *
 * **Кандидат — это `users` с `kind = 'candidate'`** (§3.1, решение docs/v2/44 В-8). Отдельной
 * таблицы людей нет: прохождение контента уже завязано на `users`, и при найме история должна
 * сохраниться без миграции строк — меняется одно поле, переносится ноль записей.
 *
 * Отсюда главное правило файла: **ни одной выборки людей мимо `repo/people.ts`**. Забытый
 * фильтр по виду не падает, а молча возвращает кандидатов в списки сотрудников, в адресаты
 * рассылок и в оплачиваемый счётчик (docs/v2/42 §7.1). Сканер
 * `tests/integration/users-kind-filter.spec.ts` красит гейт на обходе, канареечный кандидат
 * в посеве ловит то, что сканер пропустил.
 *
 * Две оси состояния (§4.1) не сливаются: `users.candidate_state` — пять терминальных значений,
 * на них смотрят отчёты и лимит тарифа; `users.candidate_status_id` — колонка канбана,
 * справочник тенанта. Переход между колонками двигает ось состояния только через `maps_to`.
 *
 * Чего здесь нет: найма, отказа, архивации, приглашений и авто-переходов — это PR-14
 * (`45-plan.md`), и ручки §10 под них появятся вместе с воронкой. Здесь — схема, карточка,
 * статусы, история и оценки.
 */

export interface Ctx { tenantId: string, actorId: string }

/**
 * Кто смотрит карточку. Собирается из `Access` функцией `viewerOf()` в эндпоинте — сервис
 * не лезет в сессию (тенант и актор приходят снаружи, CLAUDE.md п. 2).
 *
 * `locations = null` — вся сеть (`candidate.view` на весь тенант: HR, админ, рекрутер сети).
 * Непустой массив — роль с областью «точка»: керівник точки. Точка кандидата приезжает вместе
 * с `users.vacancy_id` в PR-15 (решение В-13 отложило колонку), поэтому до тех пор областная
 * роль видит **только своих** кандидатов — тех, где она назначена рекрутером (§5.1 «рекрутер
 * видит своих + точек»). Чужой кандидат для неё не существует: `404`, не `403` (CLAUDE.md п. 15,
 * критерий §13 к. 9).
 */
export interface Viewer extends Ctx {
  locations: string[] | null
  /** Видит ПД в полном объёме: телефон, e-mail, резюме без маскирования (§7.10). */
  fullPd: boolean
  /** Наставник: карточка в объёме проверки — без контактов, резюме и комментариев (§2). */
  reviewOnly: boolean
}

/**
 * `Access` сессии → `Viewer` карточки (§2, §7.10). Одно место, где роли превращаются в объём
 * видимости ПД, — иначе маскирование пришлось бы повторять в каждой ручке, а повторенное
 * правило рано или поздно разъезжается.
 *
 * Полный объём ПД даёт только `candidate.view` на весь тенант: HR, админ, рекрутер сети.
 * Роль с областью «точка» (керівник точки) видит контакты маскированными (§2 «✓ маскировано»).
 * Наставник `candidate.view` не имеет вовсе: ему карточка открыта в объёме проверки — без
 * контактов, резюме и комментариев (§2, критерий §13 к. 10). «Какая именно проверка ему
 * назначена» решает очередь проверки (PR-19, `scopeCond`): делегированная работа карточку
 * кандидата не открывает (сквозная проверка 20).
 */
export function viewerOf(access: { userId: string, tenantId: string, grants: { scopes: string[], scopeType: string, scopeId: string | null }[] }): Viewer {
  const withView = access.grants.filter(g => g.scopes.includes('candidate.view'))
  const tenantWide = withView.some(g => g.scopeType === 'tenant')
  const locations = tenantWide ? null : withView.filter(g => g.scopeType === 'location' && g.scopeId).map(g => g.scopeId!)
  const canReview = access.grants.some(g => g.scopes.includes('review.queue') || g.scopes.includes('review.grade'))
  return {
    tenantId: access.tenantId,
    actorId: access.userId,
    locations,
    fullPd: tenantWide,
    reviewOnly: withView.length === 0 && canReview,
  }
}

export interface CandidateRow {
  id: string
  fullName: string
  lastName: string | null
  firstName: string | null
  middleName: string | null
  phone: string | null
  email: string | null
  state: CandidateState
  statusId: string | null
  statusCode: string | null
  statusNameUk: string | null
  statusColor: string | null
  mapsTo: CandidateState | null
  source: string | null
  sourceDetail: string | null
  recruiterId: string | null
  recruiterName: string | null
  vacancyId: string | null
  vacancyTitle: string | null
  accessUntil: string | null
  commLanguage: string
  resumeAssetId: string | null
  consentGivenAt: Date | null
  consentExpiresAt: string | null
  lastSeenAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface ScoreRow {
  id: string
  kind: CandidateScoreKind
  valueNum: string | null
  scaleId: string | null
  scaleLevelId: string | null
  comment: string | null
  sourceType: string | null
  sourceId: string | null
  authorId: string | null
  isCurrent: boolean
  /**
   * Оценку ИИ дала заглушка, а не модель (`docs/v2/30` §7.2 г, Р-28.4): карточка показывает
   * пометку рядом с числом — такая оценка не основание для решения человека.
   */
  aiStub: boolean
  createdAt: Date
}

/**
 * Строка ленты «Історія» (§5.3). `event = 'status'` — смена колонки канбана
 * (`candidate_status_history`); `interview_declined` / `interview_withdrawn` — нейтральные
 * строки собеседования (`docs/v2/30` §7.5, §7.6): «обрав альтернативний формат», «відкликав
 * згоду». Отказ от ИИ не пишется в оценки и не выглядит минусом — это просто событие отбора.
 */
export interface HistoryRow {
  id: string
  event: 'status' | 'interview_declined' | 'interview_withdrawn'
  fromStatusId: string | null
  toStatusId: string | null
  toStatusNameUk: string | null
  reasonCode: string | null
  reasonText: string | null
  /** Альтернатива, выбранная вместо ИИ-собеседования (`interview_declined`). */
  alternative: string | null
  actorId: string | null
  isAutomatic: boolean
  createdAt: Date
}

export interface CommentRow {
  id: string
  authorId: string
  authorName: string | null
  body: string
  visibility: string
  createdAt: Date
  editedAt: Date | null
}

export interface CandidateCard extends CandidateRow {
  /** Дней в текущей колонке канбана — от последней записи истории, а не от создания (§7.11). */
  daysInStatus: number | null
  /** Контакты и резюме скрыты: у смотрящего нет `candidate.view` в полном объёме (§7.10). */
  pdMasked: boolean
  scores: ScoreRow[]
  history: HistoryRow[]
  comments: CommentRow[]
}

// ── Маскирование ПД (§7.10) ───────────────────────────────────────────────────────────────
// Делается на сервере, а не в интерфейсе: иначе полный номер уезжает в ответ API и в
// выгрузку, и «маскирование» становится косметикой поверх утечки.

/** `+380671234567` → `+380** *** ** 67`: код страны и две последние цифры (§7.10). */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null
  if (phone.length < 8) return '***'
  return `${phone.slice(0, 4)}** *** ** ${phone.slice(-2)}`
}

/** `anna@gmail.com` → `a****@gmail.com` (§7.10). */
export function maskEmail(email: string | null): string | null {
  if (!email) return null
  const at = email.indexOf('@')
  if (at < 1) return '***'
  return `${email[0]}****${email.slice(at)}`
}

// ── Выборки ───────────────────────────────────────────────────────────────────────────────

export const COLUMNS = {
  id: users.id,
  fullName: users.fullName,
  lastName: users.lastName,
  firstName: users.firstName,
  middleName: users.middleName,
  phone: users.phone,
  email: users.email,
  state: users.candidateState,
  statusId: users.candidateStatusId,
  source: users.source,
  sourceDetail: users.sourceDetail,
  recruiterId: users.recruiterId,
  vacancyId: users.vacancyId,
  accessUntil: users.accessUntil,
  commLanguage: users.commLanguage,
  resumeAssetId: users.resumeAssetId,
  consentGivenAt: users.consentGivenAt,
  consentExpiresAt: users.consentExpiresAt,
  lastSeenAt: users.lastSeenAt,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
  /**
   * Подзапросы называют внешнюю колонку полным именем таблицы через `sql.raw`, а не
   * подстановкой объекта колонки: Drizzle рендерит её в `sql` без квалификатора, и внутри
   * подзапроса выигрывает ближняя область видимости. Пока у внутренней таблицы такой
   * колонки нет, имя «проваливается» наружу и всё работает; стоит ей появиться — условие
   * тихо начинает сравнивать строку саму с собой (так и случилось с `recruiterName`:
   * `u2.id = u2.recruiter_id` не падало, а молча отдавало пустое имя рекрутера —
   * исправлено в PR-15).
   */
  statusCode: sql<string | null>`(select s.code from candidate_statuses s where s.id = ${sql.raw('users.candidate_status_id')})`,
  statusNameUk: sql<string | null>`(select s.name_uk from candidate_statuses s where s.id = ${sql.raw('users.candidate_status_id')})`,
  statusColor: sql<string | null>`(select s.color from candidate_statuses s where s.id = ${sql.raw('users.candidate_status_id')})`,
  mapsTo: sql<CandidateState | null>`(select s.maps_to from candidate_statuses s where s.id = ${sql.raw('users.candidate_status_id')})`,
  /**
   * ФИО рекрутера подзапросом, а не вторым соединением с `users`: соединение ради одного
   * имени запутало бы сканер П-16.1, а выборка по первичному ключу фильтра по виду не
   * требует — рекрутер всегда сотрудник, и это обеспечено при записи, а не при чтении.
   */
  recruiterName: sql<string | null>`(select u2.full_name from users u2 where u2.id = ${sql.raw('users.recruiter_id')})`,
  /** Вакансия отклика (`28` §3.2, колонка PR-15): название подзапросом, как и ФИО рекрутера. */
  vacancyTitle: sql<string | null>`(select v.title from vacancies v where v.id = ${sql.raw('users.vacancy_id')})`,
}

/**
 * Ограничение области: областная роль видит только своих кандидатов (см. `Viewer`).
 * Пустой массив точек — не видит ничего вовсе.
 */
export function scopeCond(v: Viewer) {
  // Наставник (§2 «только назначенную ему проверку») видит кандидата ровно тогда, когда есть
  // что проверять: открытая работа кандидата в очереди проверки (источник истины, docs/v2/44
  // В-2), назначенная ему, взятая им или лежащая в общем пуле, из которого он берёт. Не «любой
  // кандидат без контактов» — иначе критерий §13 к. 10 превратился бы в разрешение смотреть всю
  // воронку.
  //
  // **Делегирование карточку кандидата не открывает** (сквозная проверка 20, `docs/v2/42` §5;
  // `docs/v2/37` §1): работу, переданную по цепочке, делегат проверяет в карточке проверки
  // (`GET /review/items/:id` — ответ, критерии, история попыток, без контактов), а сюда
  // получает `404`. Доступ к записи о человеке выдаёт организация (роль, правило
  // распределения), а не коллега передачей работы.
  if (v.reviewOnly) {
    return sql`exists (
      select 1 from review_queue_items q
       where q.user_id = ${users.id} and q.status <> 'done' and q.delegation_id is null
         and (q.assigned_reviewer_id = ${v.actorId}::uuid or q.claimed_by = ${v.actorId}::uuid
              or q.assigned_reviewer_id is null)
    )`
  }
  if (v.locations === null) return undefined
  return eq(users.recruiterId, v.actorId)
}

/** Список кандидатов (`28` §5.1, §10 `GET /candidates`). Всегда через репозиторный слой. */
export async function listCandidates(v: Viewer, filter: CandidateListFilter): Promise<CandidateRow[]> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const q = filter.q?.trim()
    const conds = [
      scopeCond(v),
      filter.state ? eq(users.candidateState, filter.state) : undefined,
      filter.statusId ? eq(users.candidateStatusId, filter.statusId) : undefined,
      filter.recruiterId ? eq(users.recruiterId, filter.recruiterId) : undefined,
      filter.vacancyId ? eq(users.vacancyId, filter.vacancyId) : undefined,
      filter.source ? eq(users.source, filter.source) : undefined,
      filter.from ? gte(users.createdAt, new Date(`${filter.from}T00:00:00Z`)) : undefined,
      filter.to ? lte(users.createdAt, new Date(`${filter.to}T23:59:59Z`)) : undefined,
      q ? or(sql`${users.fullName} ilike ${`%${q}%`}`, sql`${users.phone} ilike ${`%${q}%`}`, sql`${users.email} ilike ${`%${q}%`}`) : undefined,
    ]
    const rows = await candidatesQuery(tx, COLUMNS, ...conds)
      .orderBy(desc(users.createdAt))
      .limit(filter.limit) as unknown as CandidateRow[]
    return rows.map(r => maskRow(v, r))
  })
}

export function maskRow<T extends { phone: string | null, email: string | null }>(v: Viewer, row: T): T {
  if (v.fullPd) return row
  return { ...row, phone: maskPhone(row.phone), email: maskEmail(row.email) }
}

/**
 * Карточка (`28` §5.3, §10 `GET /candidates/:id`). `null` — нет такого кандидата **или** он
 * вне области смотрящего: и то и другое даёт `404`, существование чужой записи не
 * подтверждается (CLAUDE.md п. 15, критерий §13 к. 9).
 *
 * Наставнику (`reviewOnly`) карточка приходит без контактов, резюме и комментариев: он
 * оценивает работу, а не человека (§2). Полный объём ПД — только с `candidate.view` на сеть.
 */
export async function getCandidate(v: Viewer, id: string): Promise<CandidateCard | null> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const [row] = await candidatesQuery(tx, COLUMNS, eq(users.id, id), scopeCond(v)) as unknown as CandidateRow[]
    if (!row) return null
    const scores = await tx.select({
      id: candidateScores.id,
      kind: candidateScores.kind,
      valueNum: candidateScores.valueNum,
      scaleId: candidateScores.scaleId,
      scaleLevelId: candidateScores.scaleLevelId,
      comment: candidateScores.comment,
      sourceType: candidateScores.sourceType,
      sourceId: candidateScores.sourceId,
      authorId: candidateScores.authorId,
      isCurrent: candidateScores.isCurrent,
      aiStub: candidateScores.aiStub,
      createdAt: candidateScores.createdAt,
    }).from(candidateScores)
      .where(eq(candidateScores.candidateId, id))
      .orderBy(desc(candidateScores.createdAt)) as unknown as ScoreRow[]

    const statusHistory = await historyOf(tx, id)
    const history = await withInterviewEvents(tx, id, statusHistory)
    const comments = v.reviewOnly ? [] : await commentsOf(tx, id)
    // «Днів у статусі» — от последней смены колонки (§7.11), события собеседования его не сбрасывают
    const last = statusHistory[0]
    // Часы приложения и БД расходятся на доли секунды, и «только что перенесли» легко даёт
    // −1 день. Отрицательного стажа в колонке не бывает — приводим к нулю здесь, а не на экране.
    const daysInStatus = last ? Math.max(0, Math.floor((Date.now() - new Date(last.createdAt).getTime()) / 86_400_000)) : null

    const card: CandidateCard = {
      ...maskRow(v, row),
      daysInStatus,
      pdMasked: !v.fullPd,
      scores,
      history,
      comments,
    }
    if (!v.fullPd) card.resumeAssetId = null // резюме — те же ПД, что телефон (§2, §7.10)
    return card
  })
}

async function historyOf(tx: TenantTx, candidateId: string): Promise<HistoryRow[]> {
  return await tx.select({
    id: candidateStatusHistory.id,
    event: sql<'status'>`'status'`,
    alternative: sql<string | null>`null`,
    fromStatusId: candidateStatusHistory.fromStatusId,
    toStatusId: candidateStatusHistory.toStatusId,
    toStatusNameUk: candidateStatuses.nameUk,
    reasonCode: candidateStatusHistory.reasonCode,
    reasonText: candidateStatusHistory.reasonText,
    actorId: candidateStatusHistory.actorId,
    isAutomatic: candidateStatusHistory.isAutomatic,
    createdAt: candidateStatusHistory.createdAt,
  }).from(candidateStatusHistory)
    .leftJoin(candidateStatuses, eq(candidateStatuses.id, candidateStatusHistory.toStatusId))
    .where(eq(candidateStatusHistory.candidateId, candidateId))
    .orderBy(desc(candidateStatusHistory.createdAt)) as unknown as HistoryRow[]
}

/**
 * Лента истории вместе с решениями по согласию на ИИ-собеседование (`docs/v2/30` §7.5, §7.6,
 * §13 к. 2: «в истории нейтральная строка»). Журнал колонок канбана не получает переходов «в
 * себя» ради этих строк — они читаются из `interview_consents` и вплетаются по времени.
 */
async function withInterviewEvents(tx: TenantTx, candidateId: string, history: HistoryRow[]): Promise<HistoryRow[]> {
  const rows = await tx.execute(sql`
    select id, decision, alternative_chosen, coalesce(withdrawn_at, decided_at) as at
      from interview_consents
     where user_id = ${candidateId}::uuid and decision in ('declined', 'withdrawn')`) as unknown as { id: string, decision: 'declined' | 'withdrawn', alternative_chosen: string | null, at: Date | string }[]
  if (!rows.length) return history
  const events: HistoryRow[] = rows.map(r => ({
    id: r.id,
    event: r.decision === 'declined' ? 'interview_declined' : 'interview_withdrawn',
    fromStatusId: null,
    toStatusId: null,
    toStatusNameUk: null,
    reasonCode: null,
    reasonText: null,
    alternative: r.alternative_chosen,
    actorId: candidateId,
    isAutomatic: false,
    createdAt: new Date(r.at),
  }))
  return [...history, ...events].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

async function commentsOf(tx: TenantTx, candidateId: string): Promise<CommentRow[]> {
  return await tx.select({
    id: candidateComments.id,
    authorId: candidateComments.authorId,
    authorName: sql<string | null>`(select u2.full_name from users u2 where u2.id = ${candidateComments.authorId})`,
    body: candidateComments.body,
    visibility: candidateComments.visibility,
    createdAt: candidateComments.createdAt,
    editedAt: candidateComments.editedAt,
  }).from(candidateComments)
    .where(and(eq(candidateComments.candidateId, candidateId), isNull(candidateComments.deletedAt)))
    .orderBy(desc(candidateComments.createdAt)) as unknown as CommentRow[]
}

// ── Дубликаты (§7.2, §7.3, §12.1; критерий §13 к. 2) ──────────────────────────────────────

export interface DuplicateHit {
  id: string
  fullName: string
  kind: 'employee' | 'candidate'
  state: CandidateState | null
  statusNameUk: string | null
  createdAt: Date
  /** Отказ позднее чем 6 месяцев назад — предупреждение, а не блокировка (§7.3). */
  recentlyRejected: boolean
  /** Совпал сам контакт: телефон или почта заняты в тенанте (`unique (tenant_id, phone)`). */
  matchedContact: boolean
}

/**
 * Поиск того же человека по телефону и e-mail **среди всех людей тенанта** — и кандидатов,
 * и сотрудников (§7.2). Это не список людей, а проверка ключа: `unique (tenant_id, phone)`
 * не различает вид, и фильтр по виду сделал бы проверку неверной, а не безопасной.
 */
export async function findDuplicates(ctx: Ctx, contact: { phone?: string | null, email?: string | null }): Promise<DuplicateHit[]> {
  const phone = contact.phone?.trim() || null
  const email = contact.email?.trim() || null
  if (!phone && !email) return []
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select u.id, u.full_name, u.kind, u.candidate_state,
             (select s.name_uk from candidate_statuses s where s.id = u.candidate_status_id) as status_name_uk,
             u.created_at,
             exists (
               select 1 from candidate_status_history h
               where h.candidate_id = u.id and h.reason_code is not null
                 and u.candidate_state = 'rejected' and h.created_at > now() - interval '6 months'
             ) as recently_rejected
        from users u
       where (${phone}::text is not null and u.phone = ${phone})
          or (${email}::text is not null and u.email = ${email})
       order by u.created_at desc
       limit 10
    `) as unknown as { id: string, full_name: string, kind: 'employee' | 'candidate', candidate_state: CandidateState | null, status_name_uk: string | null, created_at: Date, recently_rejected: boolean }[]
    return rows.map(r => ({
      id: r.id,
      fullName: r.full_name,
      kind: r.kind,
      state: r.candidate_state,
      statusNameUk: r.status_name_uk,
      createdAt: r.created_at,
      recentlyRejected: Boolean(r.recently_rejected),
      // Выборка идёт ровно по телефону и почте, поэтому любое попадание означает занятый
      // контакт: `unique (tenant_id, phone)` и `unique (tenant_id, email)` — на всех людей
      // тенанта сразу, кандидат и сотрудник делят одно пространство ключей.
      matchedContact: true,
    }))
  })
}

// ── Создание и правка ─────────────────────────────────────────────────────────────────────

export type CreateResult =
  | { ok: true, candidate: CandidateRow }
  | { ok: false, code: 'contact_required' }
  | { ok: false, code: 'is_employee', duplicates: DuplicateHit[] }
  | { ok: false, code: 'duplicate', duplicates: DuplicateHit[] }
  | { ok: false, code: 'contact_taken', duplicates: DuplicateHit[] }
  | { ok: false, code: 'limit_exceeded', limit: number | null, current: number }
  | { ok: false, code: 'status_not_found' }

/**
 * Создание кандидата (§6.1, §7.1, §7.2, §10 `POST /candidates`).
 *
 * Порядок проверок — от самой дешёвой ошибки к самой дорогой: контакт → человек уже работает
 * (§12.1) → дубликат без подтверждения (§7.2) → лимит тарифа (§7.1). Лимит проверяется
 * последним, потому что он единственный обращается к оси и пополняет счётчик.
 *
 * Согласие на обработку ПД проставляет сервер: `consent_given_at = now()`,
 * `consent_expires_at = +6 мес.` (§7.9). Клиент присылает только факт подтверждения — дату
 * согласия нельзя принимать из тела запроса, иначе срок стирания назначает себе сам клиент.
 */
export async function createCandidate(ctx: Ctx, input: CandidateCreateInput): Promise<CreateResult> {
  const blocked = await precheckCandidate(ctx, input)
  if (blocked) return blocked
  return withTenant(ctx.tenantId, ctx.actorId, tx => createCandidateTx(tx, ctx, input))
}

/**
 * Проверки **до** транзакции: контакт, человек уже работает (§12.1), дубликат без
 * подтверждения (§7.2), лимит тарифа (§7.1). Возвращает отказ или `null`, если путь открыт.
 *
 * Вынесено отдельно, потому что у создания кандидата два входа — форма рекрутера и отклик
 * по публичной ссылке (§7.20, PR-16), — и второй обязан идти **одной транзакцией** вместе
 * с назначением. Обе проверки, которые ходят мимо транзакции тенанта (`findDuplicates`
 * своим `withTenant`, лимит — подключением платформы), поэтому стоят перед ней, а не внутри:
 * вложенная транзакция другого подключения всё равно не откатилась бы вместе с внешней.
 */
export async function precheckCandidate(ctx: Ctx, input: { phone?: string | null, email?: string | null, confirmDuplicate?: boolean }): Promise<Exclude<CreateResult, { ok: true }> | null> {
  const phone = input.phone?.trim() || null
  const email = input.email?.trim() || null
  if (!phone && !email) return { ok: false, code: 'contact_required' }

  const dups = await findDuplicates(ctx, { phone, email })
  const employee = dups.find(d => d.kind === 'employee')
  if (employee) return { ok: false, code: 'is_employee', duplicates: dups }
  if (dups.length && !input.confirmDuplicate) return { ok: false, code: 'duplicate', duplicates: dups }
  // Подтверждение (§7.2) снимает предупреждение, но не отменяет ключ: `unique (tenant_id, phone)`
  // и `unique (tenant_id, email)` базового ТЗ абсолютны и общие для обоих видов людей. Поэтому
  // второй профиль с тем же контактом не создаётся никогда, и это не обход §7.2, а её же §12.10:
  // повторный отклик того же человека — событие в истории существующей карточки, а не новая.
  if (dups.some(d => d.matchedContact)) return { ok: false, code: 'contact_taken', duplicates: dups }

  const { checkPlanLimit } = await import('./platform')
  const limit = await checkPlanLimit(ctx.tenantId, 'candidates')
  if (!limit.ok) return { ok: false, code: 'limit_exceeded', limit: limit.limit, current: limit.current }
  return null
}

/**
 * Тело создания кандидата в **уже открытой** транзакции тенанта. Единственная точка, где
 * появляется строка `users` с `kind = 'candidate'`; проверки перед ней — `precheckCandidate()`.
 *
 * `opts.consentGivenAt` — единственное отступление от правила «дату согласия ставит сервер»:
 * отклик по публичной ссылке уже записал момент галочки в `vacancy_applications`
 * (`29` §7.23), и подставлять сюда время транзакции найма нельзя — срок стирания ПД
 * отсчитывался бы не от реального согласия. Значение приходит из строки БД, а не из тела
 * запроса: в `candidateCreateSchema` такого поля нет и не появится.
 */
export async function createCandidateTx(tx: TenantTx, ctx: Ctx, input: CandidateCreateInput, opts: { consentGivenAt?: Date, automatic?: boolean } = {}): Promise<CreateResult> {
  const phone = input.phone?.trim() || null
  const email = input.email?.trim() || null
  {
    const status = input.statusId
      ? (await tx.select().from(candidateStatuses).where(eq(candidateStatuses.id, input.statusId)))[0]
      : (await tx.select().from(candidateStatuses).where(eq(candidateStatuses.code, 'new')))[0]
    if (!status) return { ok: false, code: 'status_not_found' } as CreateResult

    const parts = splitName({ lastName: input.lastName, firstName: input.firstName, middleName: input.middleName ?? null })
    // Срок стирания ПД считается **от момента согласия**, а не от момента записи (§7.9,
    // `29` §7.23): у отклика по ссылке между галочкой и транзакцией проходят сутки ожидания
    // кода, и отсчёт от найма молча продлил бы хранение данных человека.
    const consentGivenAt = opts.consentGivenAt ?? new Date()
    const expires = new Date(consentGivenAt)
    expires.setUTCMonth(expires.getUTCMonth() + CANDIDATE_CONSENT_MONTHS)

    const [person] = await tx.insert(users).values({
      tenantId: ctx.tenantId,
      kind: 'candidate',
      candidateState: 'active',
      candidateStatusId: status.id,
      fullName: parts.fullName,
      lastName: parts.lastName,
      firstName: parts.firstName,
      middleName: parts.middleName,
      phone,
      email,
      status: 'invited',
      source: input.source ?? 'manual',
      sourceDetail: input.sourceDetail ?? null,
      recruiterId: input.recruiterId ?? ctx.actorId,
      vacancyId: input.vacancyId ?? null,
      accessUntil: input.accessUntil ?? null,
      commLanguage: input.commLanguage,
      resumeAssetId: input.resumeAssetId ?? null,
      consentGivenAt,
      consentExpiresAt: expires.toISOString().slice(0, 10),
    }).returning({ id: users.id })

    await tx.insert(candidateStatusHistory).values({
      tenantId: ctx.tenantId,
      candidateId: person!.id,
      fromStatusId: null,
      toStatusId: status.id,
      actorId: ctx.actorId,
      isAutomatic: opts.automatic ?? false,
      requestContext: currentRequestContext(),
    })

    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'candidate.create',
      entity: 'user',
      entityId: person!.id,
      after: { fullName: parts.fullName, source: input.source ?? 'manual', statusCode: status.code, automatic: opts.automatic ?? false },
    })

    const [row] = await candidatesQuery(tx, COLUMNS, eq(users.id, person!.id)) as unknown as CandidateRow[]
    return { ok: true, candidate: row! } as CreateResult
  }
}

export type UpdateResult =
  | { ok: true, candidate: CandidateRow }
  | { ok: false, code: 'not_found' }
  | { ok: false, code: 'conflict', candidate: CandidateRow }
  | { ok: false, code: 'duplicate', duplicates: DuplicateHit[] }

/**
 * Правка карточки (§10 `PATCH /candidates/:id`). Оптимистическая блокировка по `updated_at`
 * (§12.6): двое двигают одну карточку, проигравший получает `409 conflict` и актуальное
 * состояние, а не молча затирает чужую правку.
 */
export async function updateCandidate(v: Viewer, id: string, input: CandidateUpdateInput): Promise<UpdateResult> {
  const current = await getCandidateRow(v, id)
  if (!current) return { ok: false, code: 'not_found' }
  if (input.updatedAt && new Date(input.updatedAt).getTime() !== new Date(current.updatedAt).getTime()) {
    return { ok: false, code: 'conflict', candidate: current }
  }
  const phone = input.phone === undefined ? undefined : (input.phone?.trim() || null)
  const email = input.email === undefined ? undefined : (input.email?.trim() || null)
  if (phone || email) {
    const dups = (await findDuplicates(v, { phone, email })).filter(d => d.id !== id)
    if (dups.length) return { ok: false, code: 'duplicate', duplicates: dups }
  }

  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const parts = (input.firstName || input.lastName || input.middleName !== undefined)
      ? splitName({
          lastName: input.lastName ?? current.lastName,
          firstName: input.firstName ?? current.firstName,
          middleName: input.middleName === undefined ? current.middleName : input.middleName,
        })
      : null
    await tx.update(users).set({
      ...(parts ? { fullName: parts.fullName, lastName: parts.lastName, firstName: parts.firstName, middleName: parts.middleName } : {}),
      ...(phone === undefined ? {} : { phone }),
      ...(email === undefined ? {} : { email }),
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.sourceDetail === undefined ? {} : { sourceDetail: input.sourceDetail }),
      ...(input.recruiterId === undefined ? {} : { recruiterId: input.recruiterId }),
      ...(input.vacancyId === undefined ? {} : { vacancyId: input.vacancyId }),
      ...(input.accessUntil === undefined ? {} : { accessUntil: input.accessUntil }),
      ...(input.commLanguage === undefined ? {} : { commLanguage: input.commLanguage }),
      ...(input.resumeAssetId === undefined ? {} : { resumeAssetId: input.resumeAssetId }),
      ...(input.consentExpiresAt === undefined ? {} : { consentExpiresAt: input.consentExpiresAt }),
      updatedAt: new Date(),
    }).where(and(eq(users.id, id), candidateOnly()))

    await recordAudit(tx, {
      tenantId: v.tenantId,
      actorId: v.actorId,
      action: 'candidate.update',
      entity: 'user',
      entityId: id,
      before: { fullName: current.fullName, recruiterId: current.recruiterId, accessUntil: current.accessUntil },
      after: { ...(parts ? { fullName: parts.fullName } : {}), ...(input.recruiterId === undefined ? {} : { recruiterId: input.recruiterId }), ...(input.accessUntil === undefined ? {} : { accessUntil: input.accessUntil }) },
    })
    const [row] = await candidatesQuery(tx, COLUMNS, eq(users.id, id)) as unknown as CandidateRow[]
    return { ok: true, candidate: maskRow(v, row!) } as UpdateResult
  })
}

async function getCandidateRow(v: Viewer, id: string): Promise<CandidateRow | null> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const [row] = await candidatesQuery(tx, COLUMNS, eq(users.id, id), scopeCond(v)) as unknown as CandidateRow[]
    return row ?? null
  })
}

// ── Колонка канбана и состояние воронки (§4) ──────────────────────────────────────────────

export type MoveResult =
  | { ok: true, candidate: CandidateRow }
  | { ok: false, code: 'not_found' }
  | { ok: false, code: 'status_not_found' }
  | { ok: false, code: 'same' }
  | { ok: false, code: 'not_allowed', from: CandidateState, to: CandidateState }
  | { ok: false, code: 'reason_required' }

/**
 * Разрешённые переходы оси `candidate_state` (§4.2). Из `hired` не ведёт ни один: ошибочный
 * найм исправляется офбордингом (`docs/v2/33`), а не возвратом в воронку — иначе в системе
 * появляется сотрудник с живым прогрессом, «возвращённый в кандидаты», и отчёты по штату
 * начинают врать. Критерий §13 к. 11 проверяет ровно это.
 */
const ALLOWED: Record<CandidateState, CandidateState[]> = {
  active: ['hired', 'rejected', 'archived', 'withdrawn'],
  rejected: ['active', 'archived'],
  archived: ['active'],
  withdrawn: ['active'],
  hired: [],
}

export function canMove(from: CandidateState, to: CandidateState): boolean {
  return from === to || ALLOWED[from].includes(to)
}

/**
 * Перенос кандидата в другую колонку канбана (§10 `POST /candidates/:id/status`).
 *
 * Колонка тянет за собой ось состояния через `maps_to` (§4.1) — и только по разрешённому
 * переходу. Найм (`maps_to='hired'`) этой ручкой не делается: он транзакционный, меняет `kind`
 * и два лимита сразу (§7.6) и живёт в PR-14; здесь такая колонка отвергается как недопустимый
 * переход, чтобы «найм мимо найма» не появился раньше самого найма.
 */
export async function moveStatus(v: Viewer, id: string, input: CandidateStatusMoveInput): Promise<MoveResult> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const [row] = await candidatesQuery(tx, COLUMNS, eq(users.id, id), scopeCond(v)) as unknown as CandidateRow[]
    if (!row) return { ok: false, code: 'not_found' }
    const [status] = await tx.select().from(candidateStatuses).where(eq(candidateStatuses.id, input.statusId))
    if (!status || !status.isActive) return { ok: false, code: 'status_not_found' }
    if (row.statusId === status.id) return { ok: false, code: 'same' }

    const to = status.mapsTo as CandidateState
    if (to === 'hired' || !canMove(row.state, to)) return { ok: false, code: 'not_allowed', from: row.state, to }
    // Отказ без причины не пишется: причина уходит в отчёт «Отказы по причинам» (§9) и в письмо
    // кандидату (§6.2), и восстановить её задним числом неоткуда.
    if (to === 'rejected' && !input.reasonCode && !input.reasonText) return { ok: false, code: 'reason_required' }

    await tx.update(users).set({
      candidateStatusId: status.id,
      candidateState: to,
      updatedAt: new Date(),
    }).where(and(eq(users.id, id), candidateOnly()))

    await tx.insert(candidateStatusHistory).values({
      tenantId: v.tenantId,
      candidateId: id,
      fromStatusId: row.statusId,
      toStatusId: status.id,
      reasonCode: input.reasonCode ?? null,
      reasonText: input.reasonText ?? null,
      actorId: v.actorId,
      isAutomatic: false,
      requestContext: currentRequestContext(),
    })

    await recordAudit(tx, {
      tenantId: v.tenantId,
      actorId: v.actorId,
      action: 'candidate.status',
      entity: 'user',
      entityId: id,
      before: { statusId: row.statusId, state: row.state },
      after: { statusId: status.id, state: to, reasonCode: input.reasonCode ?? null },
    })

    const [updated] = await candidatesQuery(tx, COLUMNS, eq(users.id, id)) as unknown as CandidateRow[]
    return { ok: true, candidate: maskRow(v, updated!) }
  })
}

/** История колонок (§3.6, §5.3 вкладка «Історія»). */
export async function listHistory(v: Viewer, id: string): Promise<HistoryRow[] | null> {
  const row = await getCandidateRow(v, id)
  if (!row) return null
  return withTenant(v.tenantId, v.actorId, async tx => withInterviewEvents(tx, id, await historyOf(tx, id)))
}

/**
 * Виден ли кандидат этому зрителю — та же область, что у карточки (§2, §7.10). Для ручек,
 * которые живут под `/candidates/:id/*` в других модулях (собеседование `docs/v2/30` §10):
 * невидимый кандидат для них не существует — `404`, не `403` (CLAUDE.md п. 15).
 */
export async function candidateVisible(v: Viewer, id: string): Promise<boolean> {
  if (v.reviewOnly) return false
  return !!(await getCandidateRow(v, id))
}

// ── Оценки (§3.4) ─────────────────────────────────────────────────────────────────────────

export type ScoreResult =
  | { ok: true, score: ScoreRow }
  | { ok: false, code: 'not_found' }
  | { ok: false, code: 'scale_not_found' }

/**
 * Новая оценка (§10 `POST /candidates/:id/scores`). Новая строка того же вида снимает
 * `is_current` с предыдущей — переоценка кандидата обычное дело, а её след нужен при разборе
 * решения (§3.4). Четыре вида не сводятся в одно число: у каждого свой вопрос и свой автор.
 */
export async function addScore(v: Viewer, id: string, input: CandidateScoreInput): Promise<ScoreResult> {
  const row = await getCandidateRow(v, id)
  if (!row) return { ok: false, code: 'not_found' }
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    if (input.scaleLevelId) {
      const [lvl] = await tx.execute(sql`select id from scale_levels where id = ${input.scaleLevelId}::uuid`) as unknown as { id: string }[]
      if (!lvl) return { ok: false, code: 'scale_not_found' } as ScoreResult
    }
    await tx.update(candidateScores)
      .set({ isCurrent: false, updatedAt: new Date() })
      .where(and(eq(candidateScores.candidateId, id), eq(candidateScores.kind, input.kind), eq(candidateScores.isCurrent, true)))

    const [score] = await tx.insert(candidateScores).values({
      tenantId: v.tenantId,
      candidateId: id,
      kind: input.kind,
      valueNum: input.valueNum === undefined || input.valueNum === null ? null : String(input.valueNum),
      scaleId: input.scaleId ?? null,
      scaleLevelId: input.scaleLevelId ?? null,
      comment: input.comment ?? null,
      sourceType: input.sourceType ?? 'manual',
      sourceId: input.sourceId ?? null,
      authorId: v.actorId,
      isCurrent: true,
    }).returning()

    await recordAudit(tx, {
      tenantId: v.tenantId,
      actorId: v.actorId,
      action: 'candidate.score',
      entity: 'candidate_score',
      entityId: score!.id,
      after: { candidateId: id, kind: input.kind, valueNum: input.valueNum ?? null, scaleLevelId: input.scaleLevelId ?? null },
    })
    return { ok: true, score: score as unknown as ScoreRow } as ScoreResult
  })
}

/**
 * Оценка ИИ в карточку кандидата (`docs/v2/30` §7.1, §4 `scoring → scored`) — **единственный**
 * канал, которым вывод модели попадает в карточку: одно число `kind = 'ai'` рядом с тремя
 * человеческими, а не вместо них. Пишет владелец оценок (этот файл), зовёт — оценка
 * собеседования (`server/services/interview/pipeline.ts`) в транзакции со своими строками.
 * Прежняя оценка ИИ перестаёт быть действующей, но остаётся в истории (§3.4). Состояние
 * кандидата, колонка канбана и отказ этим путём не меняются никогда (инвариант 18).
 */
export async function writeAiScoreTx(tx: TenantTx, tenantId: string, candidateId: string, input: { value: number, sourceId: string, aiStub: boolean }): Promise<string> {
  await tx.update(candidateScores)
    .set({ isCurrent: false, updatedAt: new Date() })
    .where(and(eq(candidateScores.candidateId, candidateId), eq(candidateScores.kind, 'ai'), eq(candidateScores.isCurrent, true)))
  const [row] = await tx.insert(candidateScores).values({
    tenantId,
    candidateId,
    kind: 'ai',
    valueNum: String(input.value),
    sourceType: 'interview',
    sourceId: input.sourceId,
    authorId: null,
    isCurrent: true,
    aiStub: input.aiStub,
  }).returning({ id: candidateScores.id })
  await recordAudit(tx, {
    tenantId,
    actorId: null,
    action: 'candidate.score',
    entity: 'candidate_score',
    entityId: row!.id,
    after: { candidateId, kind: 'ai', valueNum: input.value, sourceType: 'interview', sourceId: input.sourceId, aiStub: input.aiStub },
  })
  return row!.id
}

/** Оценки кандидата: по умолчанию действующие, `history=true` — все (§10 `GET …/scores`). */
export async function listScores(v: Viewer, id: string, opts: { kind?: CandidateScoreKind, history?: boolean } = {}): Promise<ScoreRow[] | null> {
  const row = await getCandidateRow(v, id)
  if (!row) return null
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const conds = [
      eq(candidateScores.candidateId, id),
      opts.kind ? eq(candidateScores.kind, opts.kind) : undefined,
      opts.history ? undefined : eq(candidateScores.isCurrent, true),
    ].filter(Boolean)
    return await tx.select().from(candidateScores)
      .where(and(...conds))
      .orderBy(desc(candidateScores.createdAt)) as unknown as ScoreRow[]
  })
}

// ── Комментарии (§3.5) ────────────────────────────────────────────────────────────────────

/** Тред о кандидате. Наставнику не отдаётся вовсе, кандидату — никогда и ни при какой роли. */
export async function listComments(v: Viewer, id: string): Promise<CommentRow[] | null> {
  if (v.reviewOnly) return null
  const row = await getCandidateRow(v, id)
  if (!row) return null
  return withTenant(v.tenantId, v.actorId, tx => commentsOf(tx, id))
}

export async function addComment(v: Viewer, id: string, input: CandidateCommentInput): Promise<CommentRow | 'not_found'> {
  const row = await getCandidateRow(v, id)
  if (!row) return 'not_found'
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const [comment] = await tx.insert(candidateComments).values({
      tenantId: v.tenantId,
      candidateId: id,
      authorId: v.actorId,
      body: input.body,
      visibility: input.visibility,
    }).returning()
    await recordAudit(tx, {
      tenantId: v.tenantId,
      actorId: v.actorId,
      action: 'candidate.comment',
      entity: 'candidate_comment',
      entityId: comment!.id,
      after: { candidateId: id, visibility: input.visibility },
    })
    const [row2] = await commentsOf(tx, id)
    return row2!
  })
}

// ── Воронка по терминальным состояниям (§4.1, критерий §13 к. 5) ──────────────────────────

export interface FunnelRow {
  statusId: string
  code: string
  nameUk: string
  mapsTo: CandidateState
  total: number
}

/**
 * Сводка по колонкам канбана с их терминальным состоянием (§4.1, §9 п. 1).
 *
 * Именно здесь видно, зачем нужен `maps_to`: кандидаты пользовательской колонки
 * («Передзвонити») попадают в `active`, а не выпадают из отчёта — критерий §13 к. 5.
 * Полноценный отчёт по воронке со временем в статусе и конверсией — PR-14 (§9).
 */
export async function funnel(v: Viewer): Promise<FunnelRow[]> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select s.id as status_id, s.code, s.name_uk, s.maps_to,
             (select count(*)::int from users u where u.candidate_status_id = s.id and u.kind = 'candidate') as total
        from candidate_statuses s
       where s.is_active
       order by s.sort
    `) as unknown as { status_id: string, code: string, name_uk: string, maps_to: CandidateState, total: number }[]
    return rows.map(r => ({ statusId: r.status_id, code: r.code, nameUk: r.name_uk, mapsTo: r.maps_to, total: Number(r.total) }))
  })
}

/**
 * Сколько кандидатов считается в ось `candidates_active` (§7.1): только `active`.
 * `hired`, `rejected`, `archived` и `withdrawn` мест не занимают — тенант не должен платить
 * за архив (§15 Г-28.7). Сам счётчик живёт в `usageCounters.measureLive`; здесь — то же
 * определение для карточки и экрана, одной строкой и без второй формулы.
 */
export async function countActive(ctx: Ctx): Promise<number> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.execute(sql`select count(*)::int as n from users where candidate_state = 'active' and kind = 'candidate'`) as unknown as { n: number }[]
    return Number(r?.n ?? 0)
  })
}

/** Один человек по первичному ключу — карточка в журнале и проверки; вид не фильтруется (В-8). */
export async function personKind(ctx: Ctx, id: string): Promise<'employee' | 'candidate' | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await personById(tx, { kind: users.kind }, id) as unknown as { kind: 'employee' | 'candidate' }[]
    return row?.kind ?? null
  })
}
