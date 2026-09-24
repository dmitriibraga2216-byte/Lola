/**
 * Чистые правила очереди проверки: делегирование, распределение, SLA (`docs/v2/37` §7).
 *
 * Здесь нет ни одного обращения к БД — только арифметика сроков, выбор проверяющего из уже
 * собранного списка и переходы состояний. Сервисы (`reviewQueue.ts`, `reviewRouting.ts`,
 * `reviewDelegation.ts`, `reviewSla.ts`) собирают факты из базы и спрашивают у этого модуля,
 * что с ними делать. Так правила проверяются unit-тестом без базы и не расходятся между
 * местами, где применяются (`tests/unit/review-delegation-rules.spec.ts`).
 */

/** Захват карточки протухает через 30 минут бездействия (`docs/13` §4.2, §7.2). */
export const CLAIM_TTL_MS = 30 * 60_000

/** Жёсткий предел цепочки A→B→C (`37` §7.3): при глубине 3+ эскалация теряет адресата. */
export const MAX_DELEGATION_DEPTH = 2

/** Срок делегата — не раньше чем через 12 часов (`37` §6.1): меньше — это не передача, а спихивание. */
export const DELEGATION_MIN_LEAD_MS = 12 * 3_600_000

/** «Делегувати обрані» — не больше 25 строк за раз (`37` §5.1, §10 `review.bulk_limit`). */
export const BULK_DELEGATE_LIMIT = 25

/** Ёмкость по умолчанию, пока у человека нет строки `reviewer_capacity` (`37` §3.4, Г-37.8). */
export const DEFAULT_MAX_OPEN_ITEMS = 20
export const DEFAULT_DAILY_TARGET = 10

/** Состояние, в которое элемент возвращается, когда карточку закрыли без решения. */
export type RestingStatus = 'waiting' | 'delegated' | 'escalated'

/**
 * `37` §4: эскалация сильнее делегирования (работу видят двое, и это должно быть видно в
 * статусе), делегирование сильнее ожидания. Ни одно из трёх не зависит от того, кто открывал
 * карточку последним.
 */
export function restingStatus(item: { delegationId: string | null, escalatedAt: Date | null }): RestingStatus {
  if (item.escalatedAt) return 'escalated'
  if (item.delegationId) return 'delegated'
  return 'waiting'
}

/** Живой захват: карточку открыли меньше 30 минут назад. Протухший захват не держит работу. */
export function claimIsLive(claimedAt: Date | null | undefined, now: Date = new Date()): boolean {
  return !!claimedAt && now.getTime() - claimedAt.getTime() < CLAIM_TTL_MS
}

// ── Сроки ─────────────────────────────────────────────────────────────────────────────────

export interface SlaMarks { warnAt: Date, breachAt: Date, escalateAt: Date }

/**
 * Пороги 50 / 100 / 150 % (`37` §7.19). Окно — `sla_hours`, конец окна — `sla_due_at`: срок
 * хранится готовым (он ставится при постановке и **не двигается** ни делегированием, ни
 * переназначением), поэтому начало окна восстанавливается из конца, а не из `assigned_at`.
 */
export function slaMarks(slaDueAt: Date, slaHours: number): SlaMarks {
  const due = slaDueAt.getTime()
  const half = slaHours * 3_600_000 / 2
  return { warnAt: new Date(due - half), breachAt: new Date(due), escalateAt: new Date(due + half) }
}

export type SlaStep = 'warn' | 'breach' | 'escalate'

/**
 * Какие пороги сработали и ещё не отмечены. Прогон, опоздавший на несколько порогов,
 * отмечает все — но уведомление по элементу за один прогон уходит одно, самого высокого
 * порога (`notifyStep`): «осталось полдня» в момент, когда работа уже эскалирована, — шум.
 */
export function dueSlaSteps(item: { slaDueAt: Date | null, slaHours: number, slaWarnedAt: Date | null, slaBreachedAt: Date | null, escalatedAt: Date | null }, now: Date = new Date()): SlaStep[] {
  if (!item.slaDueAt) return []
  const m = slaMarks(item.slaDueAt, item.slaHours)
  const t = now.getTime()
  const out: SlaStep[] = []
  if (!item.slaWarnedAt && t >= m.warnAt.getTime()) out.push('warn')
  if (!item.slaBreachedAt && t >= m.breachAt.getTime()) out.push('breach')
  if (!item.escalatedAt && t >= m.escalateAt.getTime()) out.push('escalate')
  return out
}

/** Порог, по которому уходит уведомление в этом прогоне: самый высокий из сработавших. */
export function notifyStep(steps: SlaStep[]): SlaStep | null {
  if (steps.includes('escalate')) return 'escalate'
  if (steps.includes('breach')) return 'breach'
  if (steps.includes('warn')) return 'warn'
  return null
}

/** Часы просрочки на момент `now`, с двумя знаками (`review_sla_events.overdue_hours numeric(8,2)`). */
export function overdueHours(slaDueAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.round((now.getTime() - slaDueAt.getTime()) / 36_000) / 100)
}

/**
 * Срок делегата (`37` §6.1): не раньше +12 часов и не позже срока проверки. Для второго звена
 * цепочки верхняя граница — ещё и срок первого: когда истечёт A→B, работа вернётся к A вместе
 * со всем, что B передал дальше, и срок, выданный C позже этого момента, был бы обманом.
 */
export function delegationDueCheck(now: Date, dueAt: Date, limit: Date | null): 'ok' | 'too_soon' | 'too_late' {
  if (dueAt.getTime() < now.getTime() + DELEGATION_MIN_LEAD_MS) return 'too_soon'
  if (limit && dueAt.getTime() > limit.getTime()) return 'too_late'
  return 'ok'
}

// ── Выбор проверяющего (`37` §7.16–7.17) ──────────────────────────────────────────────────

export interface ReviewerLoad {
  id: string
  /** Открытых работ сейчас (назначено ему и не `done`). */
  open: number
  /** `reviewer_capacity.max_open_items` или 20 по умолчанию. */
  max: number
  /** `reviewer_capacity.rr_cursor` — сколько работ человек уже получил по кругу. */
  rrCursor: number
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * Круговое распределение (`37` §7.17). Кандидаты упорядочены по `users.id`; «указатель» —
 * это счётчик полученных по кругу работ у каждого: следующим идёт тот, у кого он меньше, при
 * равенстве — первый по `id`. На постоянном составе это ровно круг A→B→C→A; при выпавшем
 * (отпуск) круг продолжается среди присутствующих, не перепрыгивая через «долг» отсутствующего.
 *
 * Достигшие `max_open_items` пропускаются. Если пропущены все — берётся первый по списку с
 * игнорированием лимита и пометкой перегрузки: работа не может остаться неназначенной из-за
 * лимитов, лимит — сигнал руководителю, а не запрет.
 */
export function pickRoundRobin(candidates: ReviewerLoad[]): { id: string, overloaded: boolean } | null {
  if (!candidates.length) return null
  const sorted = [...candidates].sort(byId)
  const free = sorted.filter(c => c.open < c.max)
  if (!free.length) return { id: sorted[0]!.id, overloaded: true }
  const next = free.reduce((best, c) => (c.rrCursor < best.rrCursor ? c : best), free[0]!)
  return { id: next.id, overloaded: false }
}

/** Наименее загруженный: минимум открытых работ, при равенстве — первый по `id`. Лимит не фильтрует. */
export function pickLeastLoaded(candidates: ReviewerLoad[]): { id: string, overloaded: boolean } | null {
  if (!candidates.length) return null
  const sorted = [...candidates].sort(byId)
  const best = sorted.reduce((b, c) => (c.open < b.open ? c : b), sorted[0]!)
  return { id: best.id, overloaded: best.open >= best.max }
}

// ── Сопоставление правила (`37` §3.3, §7.16) ─────────────────────────────────────────────

export interface RuleScope {
  location_ids?: string[]
  org_node_ids?: string[]
  position_ids?: string[]
  course_ids?: string[]
}

export interface RuleShape {
  matchScope: RuleScope
  matchSubjectKind: string | null
  matchTaskTypes: string[]
}

export interface ItemShape {
  taskType: string
  subjectKind: string
  locationId: string | null
  positionId: string | null
  trackId: string | null
}

/**
 * Подходит ли правило к работе по тому, что видно из самой строки очереди. Пустой список в
 * области — «не ограничено»; пустой объект области — весь тенант. Узлы оргструктуры
 * (`org_node_ids`) отсюда не проверяются — им нужен запрос к дереву, это делает сервис.
 */
export function ruleMatches(rule: RuleShape, item: ItemShape): boolean {
  if (rule.matchTaskTypes.length && !rule.matchTaskTypes.includes(item.taskType)) return false
  if (rule.matchSubjectKind && rule.matchSubjectKind !== item.subjectKind) return false
  const s = rule.matchScope ?? {}
  if (s.location_ids?.length && (!item.locationId || !s.location_ids.includes(item.locationId))) return false
  if (s.position_ids?.length && (!item.positionId || !s.position_ids.includes(item.positionId))) return false
  if (s.course_ids?.length && (!item.trackId || !s.course_ids.includes(item.trackId))) return false
  return true
}

/** Область правила пуста — значит правило на весь тенант (`37` §3.3). */
export function scopeIsEmpty(scope: RuleScope | null | undefined): boolean {
  const s = scope ?? {}
  return !s.location_ids?.length && !s.org_node_ids?.length && !s.position_ids?.length && !s.course_ids?.length
}
