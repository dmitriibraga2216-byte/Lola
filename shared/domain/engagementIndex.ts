/**
 * Індекс навчальної залученості — «колонка %» списку людей і экран «Звідки взявся мій відсоток»
 * (docs/v2/38-people-extensions.md §3.1, §3.7, §5.2, §5.3, §7.1–§7.3; PR-35).
 *
 * **Это не «Поточний рейтинг».** В продукте два разных числа, и путать их нельзя:
 *
 * | | Індекс залученості (здесь) | Бали рейтингу (`points_ledger`) |
 * |---|---|---|
 * | Что это | индекс 0…130 %, пересчитывается целиком раз в сутки | валюта геймификации, копится и тратится |
 * | Где хранится | `users.rating_pct`, `person_rating_snapshots` | `points_ledger.balance_after` |
 * | Где видно | колонка «%» списка, карточка, `/…/rating` | «Поточний рейтинг» в «Мій розвиток» (docs/33 D-069), плитка профиля |
 * | Ручное начисление | невозможно | возможно (`bonus.grant`) |
 *
 * Имена `rating_pct` и `person_rating_snapshots` взяты из DDL пакета (`38` §3.1, §3.7) и в БД не
 * переименовываются; в коде и интерфейсе величина называется «індекс залученості» — слово
 * «рейтинг» в подписях осталось только за баллами. Баллы в формулу индекса **не входят** (`38` §7.1
 * [решение]): иначе 500 бонусов за корпоратив подняли бы учебный индекс.
 *
 * Чистые функции без Vue и Nitro: формулой пользуются сервер (`server/services/engagementIndex.ts`,
 * задача `rating.recalc`) и экран (правило «индекс — не единственное условие массового действия»
 * зеркалит список людей). Из `app/**` — через `#shared/domain/engagementIndex`, из `server/**` —
 * относительным путём (урок #108, шапка `shared/domain/dateFormat.ts`).
 */

/** Версия формулы (`38` §7.2): при смене экран расшифровки пишет «Формулу змінено {дата}». */
export const ENGAGEMENT_FORMULA_VERSION = 1

/** Потолок индекса (`38` §7.1 [решение]): 100 основы + три бонуса по 10. Выше 100 — не обрезается. */
export const ENGAGEMENT_CAP = 130
export const ENGAGEMENT_BASE_MAX = 100
export const ENGAGEMENT_BONUS_MAX = 10

/** Окно — скользящие 365 дней от даты расчёта (`38` §7.1). */
export const ENGAGEMENT_WINDOW_DAYS = 365

/** «Найдовша серія днів з навчанням: {n} з 30» — `S` насыщается на 30 днях подряд. */
export const ENGAGEMENT_STREAK_TARGET = 30

/** «Зараховано {k} з 20 дій» — `H` насыщается на 20 действиях: двадцать первое не повышает индекс. */
export const ENGAGEMENT_HELP_TARGET = 20

/**
 * Действия помощи для `H` — закрытый список (`38` §7.1): проверенная чужая сдача и принятое
 * замечание к контенту. Оба — виды ленты активности (`38` §7.9), поэтому `H` воспроизводится из
 * суточного агрегата `user_activity_daily.kinds`, который хранится бессрочно (§7.2).
 * Третье действие документа — «завершённое менторское сопровождение новичка» — события ленты не
 * имеет; до нового значения перечисления `user_activity_kind` (docs/02, CLAUDE.md п. 13) не
 * засчитывается (`46-progress.md`, PR-35, Р-35.4).
 */
export const ENGAGEMENT_HELP_KINDS = ['review_graded', 'content_issue_accepted'] as const

/** Значение старше 48 часов — серым с подсказкой «Дані оновлюються» (`38` §3.1, §5.2). */
export const ENGAGEMENT_STALE_HOURS = 48

/** Ручной пересчёт одного человека — не чаще раза в час (`38` §10, `429 recalc_too_often`). */
export const ENGAGEMENT_RECALC_COOLDOWN_MINUTES = 60

/** Ночной пересчёт идёт партиями по 500 человек (`38` §11 `rating.recalc`). */
export const ENGAGEMENT_BATCH_SIZE = 500

/**
 * Массовые действия, для которых индекс не может быть **единственным** условием (`38` §7.3 п. 1):
 * «Архівувати» и «Заблокувати». Массовой блокировки в списке пока нет — значение держит правило
 * на случай её появления, чтобы запрет не пришлось вспоминать заново.
 */
export const RATING_GUARDED_BULK_ACTIONS: readonly string[] = ['archive', 'block']

/** Ключи фильтра списка людей по индексу (`GET /people?ratingLt=&ratingGte=`). */
export const PEOPLE_RATING_FILTER_KEYS = ['ratingLt', 'ratingGte'] as const

/**
 * «Второе условие» (`38` §7.3 п. 1) — любой фильтр списка, который сужает круг людей сам по себе.
 * Вкладка статуса (`tab`) и «показать скрытых» (`includeHidden`) не сужают выбор по существу и
 * вторым условием не считаются: иначе запрет обходился бы тем, что вкладка есть всегда.
 */
export const PEOPLE_NARROWING_FILTER_KEYS = [
  'q', 'locationId', 'positionId', 'positionLevelId', 'cityId', 'orgUnitId', 'role', 'tag',
  'registeredFrom', 'registeredTo', 'activeFrom', 'activeTo',
] as const

const present = (v: unknown) => v !== undefined && v !== null && v !== '' && v !== false

/** Есть ли в фильтре условие по индексу. */
export function hasRatingCondition(filter: Record<string, unknown>): boolean {
  return PEOPLE_RATING_FILTER_KEYS.some(k => present(filter[k]))
}

/**
 * Индекс — единственное условие выбора: условие по индексу есть, а ни одного другого сужающего
 * нет. Такой фильтр не может быть основанием архивирования или блокировки (`38` §7.3 п. 1,
 * критерий §13 к. 3 — `422 rating_only_filter_forbidden`).
 */
export function ratingIsOnlyCondition(filter: Record<string, unknown>): boolean {
  return hasRatingCondition(filter) && !PEOPLE_NARROWING_FILTER_KEYS.some(k => present(filter[k]))
}

/** Запрещено ли это массовое действие с этим фильтром. */
export function ratingOnlyBulkForbidden(action: string, filter: Record<string, unknown> | null | undefined): boolean {
  return !!filter && RATING_GUARDED_BULK_ACTIONS.includes(action) && ratingIsOnlyCondition(filter)
}

// ── Формула (`38` §7.1) ─────────────────────────────────────────────────────────────────────

/** Запись на курс окна расчёта — уже отобранная сервером (окно, отмена, этап `counts_in_rating`). */
export interface IndexEnrollment {
  enrollmentId: string
  subjectId: string
  /** Название на момент расчёта — снимок для расшифровки (курс мог быть переименован). */
  title: string
  /** Обязательное назначение (`assignments.is_mandatory`) весит 2, добровольное и самозапись — 1. */
  mandatory: boolean
  /** `enrollment_status` (docs/02): `not_started` · `in_progress` · `done` · `failed`. */
  status: string
  progressPct: number
  /** Момент, с которого человек мог проходить: запись на курс, а если доступ открылся позже — `starts_at`. */
  assignedAt: string
  dueAt: string | null
  completedAt: string | null
}

export interface IndexInput {
  enrollments: readonly IndexEnrollment[]
  /** Самая длинная серия локальных дней с `level > 0` в окне (`user_activity_daily`). */
  longestStreak: number
  /** Действия помощи в окне по видам ленты (`ENGAGEMENT_HELP_KINDS`). */
  help: { reviews: number, issues: number }
}

/** Вклад одной записи в основу — строка раскрываемого списка карточки «Основа» (§5.3). */
export interface BaseItem {
  enrollmentId: string
  subjectId: string
  title: string
  mandatory: boolean
  weight: 1 | 2
  status: string
  /** `cᵢ`: 1 — завершено, доля прогресса — в процессе, 0 — провалено, прострочено, не начато. */
  credit: number
  /** `wᵢ × cᵢ` — сколько «весовых модулей» запись дала числителю. */
  contribution: number
}

/** Досрочность одной записи: доля срока, оставшаяся до дедлайна в момент завершения. */
export interface EarlyItem {
  enrollmentId: string
  title: string
  /** 0…1, `(due − completed) / (due − assigned)`. */
  share: number
}

/**
 * Числа, подставленные в формулу, — `person_rating_snapshots.breakdown` (§7.2): экран
 * расшифровки рисует их, а не пересчитывает. Ключи — `snake_case`, как в jsonb остальных таблиц.
 */
export interface IndexBreakdown {
  formula_version: number
  base: { weighted_done: number, weighted_total: number, items: BaseItem[] }
  early: { avg_share: number | null, counted: number, items: EarlyItem[] }
  streak: { longest: number, target: number }
  help: { actions: number, credited: number, reviews: number, issues: number, target: number }
}

export interface IndexResult {
  base: number
  early: number
  streak: number
  help: number
  /** `min(130, B + E + S + H)` по округлённым слагаемым: экран складывает ровно то, что показывает. */
  total: number
  breakdown: IndexBreakdown
}

/** Округление до десятых, как `numeric(5,1)`/`numeric(4,1)` колонок снимка. */
export function round1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** `cᵢ` (§7.1): `done` — 1; `in_progress` — `progress_pct / 100`; остальное — 0, но в знаменателе. */
export function enrollmentCredit(status: string, progressPct: number): number {
  if (status === 'done') return 1
  if (status === 'in_progress') return clamp(Number(progressPct) || 0, 0, 100) / 100
  return 0
}

/**
 * Доля досрочности записи или `null`, если запись в `E` не входит: `E` считается «по завершённым
 * в срок назначениям окна, у которых есть дедлайн» (§7.1). Срок раньше момента назначения —
 * деление на ноль или отрицательный срок — в `E` не входит тоже.
 */
export function earlyShare(e: Pick<IndexEnrollment, 'status' | 'assignedAt' | 'dueAt' | 'completedAt'>): number | null {
  if (e.status !== 'done' || !e.dueAt || !e.completedAt) return null
  const due = Date.parse(e.dueAt)
  const done = Date.parse(e.completedAt)
  const assigned = Date.parse(e.assignedAt)
  if (!Number.isFinite(due) || !Number.isFinite(done) || !Number.isFinite(assigned)) return null
  if (done > due || due <= assigned) return null
  return clamp((due - done) / (due - assigned), 0, 1)
}

/**
 * Индекс по формуле §7.1:
 *
 * ```
 * R = min(130, B + E + S + H)
 * B = 100 × Σ(wᵢ × cᵢ) / Σ(wᵢ)                    wᵢ = 2 обязательное, 1 добровольное
 * E = 10 × avg(max(0, (due − completed) / (due − assigned)))   по завершённым в срок с дедлайном
 * S = 10 × min(1, самая длинная серия дней с level > 0 / 30)
 * H = 10 × min(1, действия помощи / 20)
 * ```
 *
 * `null` — считать не из чего: в окне нет ни одной записи (§7.2: «—», а не «0 %» — ноль значил бы
 * «всё провалил», а не «нечего было проходить»).
 *
 * Чего в формуле нет `[решение]` (`46-progress.md`, PR-35, Р-35.2): порога «`E` не начисляется,
 * если прошло меньше `Плановий час × 0.5`» (`38` §7.3). Норма времени не участвует ни в одной
 * формуле балла, зачёта или рейтинга — ни прямо, ни коэффициентом (`docs/v2/37` §7 п. 14 (б),
 * сквозная проверка 13, критерий `37` §13 к. 11); время — сигнал качества материала, а не мерка
 * человека.
 */
export function computeEngagementIndex(input: IndexInput): IndexResult | null {
  if (input.enrollments.length === 0) return null

  const baseItems: BaseItem[] = input.enrollments.map((e) => {
    const weight = e.mandatory ? 2 : 1
    const credit = enrollmentCredit(e.status, e.progressPct)
    return {
      enrollmentId: e.enrollmentId,
      subjectId: e.subjectId,
      title: e.title,
      mandatory: e.mandatory,
      weight,
      status: e.status,
      credit: round1(credit * 100) / 100,
      contribution: round1(weight * credit * 100) / 100,
    }
  })
  const weightedTotal = baseItems.reduce((s, i) => s + i.weight, 0)
  const weightedDoneRaw = input.enrollments.reduce((s, e) => s + (e.mandatory ? 2 : 1) * enrollmentCredit(e.status, e.progressPct), 0)
  const baseRaw = weightedTotal > 0 ? ENGAGEMENT_BASE_MAX * weightedDoneRaw / weightedTotal : 0

  const earlyItems: EarlyItem[] = []
  for (const e of input.enrollments) {
    const share = earlyShare(e)
    if (share !== null) earlyItems.push({ enrollmentId: e.enrollmentId, title: e.title, share })
  }
  const avgShare = earlyItems.length ? earlyItems.reduce((s, i) => s + i.share, 0) / earlyItems.length : null
  const earlyRaw = ENGAGEMENT_BONUS_MAX * (avgShare ?? 0)

  const streakDays = Math.max(0, Math.floor(input.longestStreak || 0))
  const streakRaw = ENGAGEMENT_BONUS_MAX * Math.min(1, streakDays / ENGAGEMENT_STREAK_TARGET)

  const reviews = Math.max(0, Math.floor(input.help.reviews || 0))
  const issues = Math.max(0, Math.floor(input.help.issues || 0))
  const actions = reviews + issues
  const helpRaw = ENGAGEMENT_BONUS_MAX * Math.min(1, actions / ENGAGEMENT_HELP_TARGET)

  const base = clamp(round1(baseRaw), 0, ENGAGEMENT_BASE_MAX)
  const early = clamp(round1(earlyRaw), 0, ENGAGEMENT_BONUS_MAX)
  const streak = clamp(round1(streakRaw), 0, ENGAGEMENT_BONUS_MAX)
  const help = clamp(round1(helpRaw), 0, ENGAGEMENT_BONUS_MAX)
  const total = Math.min(ENGAGEMENT_CAP, round1(base + early + streak + help))

  return {
    base,
    early,
    streak,
    help,
    total,
    breakdown: {
      formula_version: ENGAGEMENT_FORMULA_VERSION,
      base: { weighted_done: round1(weightedDoneRaw), weighted_total: weightedTotal, items: baseItems },
      early: { avg_share: avgShare === null ? null : round1(avgShare * 1000) / 1000, counted: earlyItems.length, items: earlyItems.map(i => ({ ...i, share: round1(i.share * 1000) / 1000 })) },
      streak: { longest: streakDays, target: ENGAGEMENT_STREAK_TARGET },
      help: { actions, credited: Math.min(actions, ENGAGEMENT_HELP_TARGET), reviews, issues, target: ENGAGEMENT_HELP_TARGET },
    },
  }
}

/** Значение устарело (старше 48 часов) — цифра серая, подсказка «Дані оновлюються» (§3.1). */
export function isEngagementStale(updatedAt: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (!updatedAt) return false
  const at = typeof updatedAt === 'string' ? Date.parse(updatedAt) : updatedAt.getTime()
  return Number.isFinite(at) && now.getTime() - at > ENGAGEMENT_STALE_HOURS * 3_600_000
}

// ── Ответ `GET /people/:id/rating` (§5.3, §10) — один тип на сервер и экран ────────────────

/** Состояние цифры: посчитана; «не рассчитывается» (нет назначений в окне); ещё не считалась. */
export type EngagementState = 'ok' | 'no_assignments' | 'pending'

export interface EngagementView {
  person: { id: string, fullName: string }
  /** Свой индекс (экран «Звідки взявся мій відсоток») или чужой (руководитель, HR). */
  self: boolean
  state: EngagementState
  total: number | null
  base: number | null
  bonuses: { early: number, streak: number, help: number } | null
  breakdown: IndexBreakdown | null
  window: { from: string, to: string } | null
  calcDate: string | null
  /** `users.rating_updated_at` — момент последнего пересчёта (в том числе «не рассчитан»). */
  updatedAt: string | null
  /** Старше 48 часов — «Дані оновлюються» (§3.1). */
  stale: boolean
  /** Версия формулы и дата, с которой считается текущая, если до неё была другая (§7.2). */
  formula: { version: number, changedAt: string | null }
  /** Своя динамика за 12 месяцев (§7.3): последнее значение каждого месяца, без чужих людей. */
  history: { month: string, total: number }[]
}

