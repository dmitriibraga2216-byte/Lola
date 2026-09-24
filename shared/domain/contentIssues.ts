/**
 * Правила жалобы на материал (docs/v2/36-content-feedback.md §4, §7.2, §7.4, §7.5, §7.6,
 * §7.7, §7.8, §7.10, §7.11, §9). Чистые функции без БД: их же читают unit-тесты, форма
 * жалобы и экран карточки.
 */

import type {
  ContentIssueRescoreState, ContentIssueResolution, ContentIssueSeverity, ContentIssueStatus,
  ContentIssueTargetType, ContentIssueType,
} from '../enums'
import { CONTENT_ISSUE_LIMITS } from '../enums'

/**
 * Ключ склейки (§7.2): `target_type:target_id:block_id|-:issue_type:content_version`.
 *
 * Версия входит в ключ намеренно: та же опечатка в новой версии материала — **другой**
 * дефект, потому что её чинят в другой редакции; без версии карточка, закрытая полгода
 * назад, склеивала бы жалобы на текст, который с тех пор переписали. Блок — тоже часть
 * ключа: «битое видео в третьем блоке» и «битое видео в седьмом» автор чинит порознь.
 */
export function dedupeKeyOf(input: {
  targetType: ContentIssueTargetType
  targetId: string
  blockId?: string | null
  issueType: ContentIssueType
  contentVersion: number
}): string {
  return [input.targetType, input.targetId, input.blockId || '-', input.issueType, input.contentVersion].join(':')
}

/**
 * Severity считает система, а не человек (§7.4): иначе всё становится `blocking`.
 * `broken_*` и `tech` блокируют прохождение по определению — человек упёрся и дальше
 * не идёт; обязательный урок поднимает важность по той же причине.
 */
export function severityOf(issueType: ContentIssueType, opts: { lessonRequired?: boolean, archived?: boolean } = {}): ContentIssueSeverity {
  // Архивный материал: жалоба принимается, но без SLA и без важности (§7.13)
  if (opts.archived) return 'cosmetic'
  if (issueType === 'broken_media' || issueType === 'broken_file' || issueType === 'broken_link' || issueType === 'tech') return 'blocking'
  if (opts.lessonRequired) return 'blocking'
  if (issueType === 'typo' || issueType === 'unclear') return 'cosmetic'
  return 'normal'
}

/** Рабочие дни для SLA `blocking` (§7.6): суббота и воскресенье не считаются. */
function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from.getTime())
  let left = days
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1)
    const wd = d.getUTCDay()
    if (wd !== 0 && wd !== 6) left--
  }
  return d
}

/**
 * Срок починки (§7.6): 2 рабочих дня `blocking`, 7 — `normal`, 30 — `cosmetic`.
 * У жалобы на архивный материал срока нет вовсе (§7.13) — его ставит вызывающий,
 * передав `archived`.
 */
export function dueAtFor(severity: ContentIssueSeverity, from: Date, opts: { archived?: boolean } = {}): Date | null {
  if (opts.archived) return null
  if (severity === 'blocking') return addBusinessDays(from, 2)
  const d = new Date(from.getTime())
  d.setUTCDate(d.getUTCDate() + (severity === 'normal' ? 7 : 30))
  return d
}

/**
 * Компенсация времени попытки (§7.7 б): до 60 секунд на жалобу и не больше 180 за попытку.
 * Оба предела нужны: без первого форма превращается в паузу, без второго — три жалобы
 * подряд дают лишние девять минут на тест с таймером.
 *
 * Возвращает, на сколько секунд сдвинуть `deadline_at`.
 */
export function deadlineShiftFor(formSeconds: number | undefined, alreadyShiftedSec: number): number {
  const asked = Math.max(0, Math.floor(formSeconds ?? 0))
  const perReport = Math.min(asked, CONTENT_ISSUE_LIMITS.deadlineShiftSecPerReport)
  const left = Math.max(0, CONTENT_ISSUE_LIMITS.deadlineShiftSecPerAttempt - Math.max(0, alreadyShiftedSec))
  return Math.min(perReport, left)
}

export type RateVerdict
  = | { ok: true }
    | { ok: false, reason: 'per_day' | 'per_month' | 'per_attempt', used: number, limit: number }

/**
 * Частота подачи (§7.10): 5 в сутки, 20 за календарный месяц, 3 за попытку.
 * Отказ всегда называет, какой предел и сколько уже подано — шестая жалоба блокируется
 * **текстом, а не молча** (критерий приёмки 7, `36` §13).
 *
 * `exempt` — носители `content_issue.triage`: лимиты к ним не применяются, иначе методист,
 * разбирающий очередь, упрётся в них на четвёртой карточке.
 */
export function checkRate(counts: { day: number, month: number, attempt?: number }, opts: { exempt?: boolean, inAttempt?: boolean } = {}): RateVerdict {
  if (opts.exempt) return { ok: true }
  const L = CONTENT_ISSUE_LIMITS
  if (counts.day >= L.perDay) return { ok: false, reason: 'per_day', used: counts.day, limit: L.perDay }
  if (counts.month >= L.perMonth) return { ok: false, reason: 'per_month', used: counts.month, limit: L.perMonth }
  if (opts.inAttempt && (counts.attempt ?? 0) >= L.perAttempt) return { ok: false, reason: 'per_attempt', used: counts.attempt ?? 0, limit: L.perAttempt }
  return { ok: true }
}

/**
 * Поток пустых жалоб (§7.11): три резолюции `spam` подряд в окне 30 дней дают
 * `muted_until = now() + 14 дней`. Любая подтверждённая жалоба обнуляет серию —
 * функция возвращает новое состояние счётчиков, решение принимает вызывающий.
 */
export function nextReporterState(
  prev: { spamCount: number, consecutiveSpam: number, confirmedCount: number, rejectedCount: number, mutedUntil: Date | null },
  resolution: 'spam' | 'confirmed' | 'rejected',
  now: Date,
): { spamCount: number, consecutiveSpam: number, confirmedCount: number, rejectedCount: number, mutedUntil: Date | null, autoMuted: boolean } {
  const L = CONTENT_ISSUE_LIMITS
  if (resolution === 'confirmed') {
    return { ...prev, confirmedCount: prev.confirmedCount + 1, consecutiveSpam: 0, autoMuted: false }
  }
  if (resolution === 'rejected') {
    // За отклонённые не наказывают (§7.12): иначе люди перестанут жаловаться вовсе
    return { ...prev, rejectedCount: prev.rejectedCount + 1, autoMuted: false }
  }
  const consecutiveSpam = prev.consecutiveSpam + 1
  const autoMuted = consecutiveSpam >= L.spamStreakToMute
  const mutedUntil = autoMuted ? new Date(now.getTime() + L.muteDays * 86_400_000) : prev.mutedUntil
  return { ...prev, spamCount: prev.spamCount + 1, consecutiveSpam, mutedUntil, autoMuted }
}

/** Человек «надійний» (§7.11): доля подтверждения выше 60 % при не менее 5 жалобах. */
export function isTrustedReporter(stats: { reportsTotal: number, confirmedCount: number }): boolean {
  return stats.reportsTotal >= 5 && stats.confirmedCount / stats.reportsTotal > 0.6
}

/** Начало календарных суток и месяца в UTC — окна счёта лимитов (§7.10). */
export function rateWindows(now: Date): { dayFrom: Date, monthFrom: Date } {
  return {
    dayFrom: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
    monthFrom: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  }
}

// ── Разбор жалобы (PR-24): переходы, резолюции, пересчёт, адресация, отчёт ─────────────────

/**
 * Резолюции-подтверждения (§4, §7.12): дефект был, его устранили. Дают баллы заявителю
 * и обнуляют серию `spam` (§7.11). Переход `in_progress → fixed` требует одну из них.
 */
export const CONFIRMING_RESOLUTIONS = ['fixed', 'question_fixed', 'question_void'] as const satisfies readonly ContentIssueResolution[]

/** Резолюции отказа (§4 `* → rejected`): у каждой обязателен комментарий для заявителя. */
export const REJECTING_RESOLUTIONS = ['not_an_error', 'duplicate', 'wont_fix', 'spam'] as const satisfies readonly ContentIssueResolution[]

/**
 * Резолюции, после которых считается пересчёт результатов (§7.8): только они относятся к
 * вопросу теста — ключ исправлен (`question_fixed`) или вопрос негоден (`question_void`).
 */
export const RESCORE_RESOLUTIONS = ['question_fixed', 'question_void'] as const satisfies readonly ContentIssueResolution[]

/**
 * Карточка «на руках» у ответственного: по ним считается нагрузка шага (д) маршрутизации
 * и их же переназначает `content_issue.reassign_scan`. `fixed` сюда не входит — работа
 * сделана, карточка ждёт публикации версии, а не человека.
 */
export const OPEN_STATUSES = ['new', 'in_progress', 'deferred'] as const satisfies readonly ContentIssueStatus[]

/** Самый дальний срок «Відкласти» (§6.2: «≤180 дней вперёд»). */
export const DEFER_MAX_DAYS = 180

/** Комментарий заявителю при отказе и при «не перераховувати»: 10–1000 символов (§6.2). */
export const RESOLUTION_COMMENT_MIN = 10

export type TransitionError
  = | 'invalid_transition' // 409 content_issue.invalid_transition
    | 'forbidden' //          403: переход только администратору
    | 'resolution_required' // 400 content_issue.resolution_required
    | 'resolution_invalid' //  400: резолюция не подходит к переходу или к элементу
    | 'comment_required' //    400: отказ без комментария для заявителя
    | 'due_required' //        400: «Відкласти» без срока или срок вне 1–180 дней
    | 'rescore_pending' //     409: баллы не пересчитаны — карточку нельзя тихо закрыть

export interface TransitionInput {
  from: ContentIssueStatus
  to: ContentIssueStatus
  /** Носитель `content_issue.assign` — администратор очереди (§2: переназначение, ручное закрытие, переоткрытие). */
  isAdmin: boolean
  targetType: ContentIssueTargetType
  rescoreState: ContentIssueRescoreState
  resolution?: ContentIssueResolution | null
  resolutionComment?: string | null
  dueAt?: Date | null
  now: Date
}

/**
 * Разрешён ли переход статуса (§4). Таблица переходов одна для сервера и экрана карточки:
 * кнопки, которых нет в этой функции, экран не показывает.
 *
 * | Переход | Кто | Условие |
 * | `new → in_progress` | автор, админ | взять в работу |
 * | `deferred → in_progress` | автор, админ | вернуть отложенную `[решение PR-24]` |
 * | `in_progress → fixed` | автор, админ | резолюция-подтверждение; `question_*` — только у вопроса |
 * | `new|in_progress|deferred → rejected` | автор, админ | резолюция отказа и комментарий заявителю |
 * | `new|in_progress → deferred` | автор, админ | срок 1–180 дней вперёд |
 * | `fixed → closed` | админ | вручную (правка вне версии), если баллы не ждут пересчёта |
 * | `rejected|closed → in_progress` | админ | переоткрыть вручную |
 */
export function checkTransition(t: TransitionInput): { ok: true } | { ok: false, error: TransitionError } {
  const fail = (error: TransitionError) => ({ ok: false as const, error })
  const { from, to } = t
  if (from === to) return fail('invalid_transition')

  if (to === 'in_progress') {
    if (from === 'new' || from === 'deferred') return { ok: true }
    if (from === 'rejected' || from === 'closed') return t.isAdmin ? { ok: true } : fail('forbidden')
    return fail('invalid_transition')
  }

  if (to === 'fixed') {
    if (from !== 'in_progress') return fail('invalid_transition')
    if (!t.resolution) return fail('resolution_required')
    if (!(CONFIRMING_RESOLUTIONS as readonly string[]).includes(t.resolution)) return fail('resolution_invalid')
    // «Питання виправлено» и «Питання анульовано» — про вопрос теста, у материала их нет (§6.2)
    if ((RESCORE_RESOLUTIONS as readonly string[]).includes(t.resolution) && t.targetType !== 'question') return fail('resolution_invalid')
    return { ok: true }
  }

  if (to === 'rejected') {
    if (!(['new', 'in_progress', 'deferred'] as ContentIssueStatus[]).includes(from)) return fail('invalid_transition')
    if (!t.resolution) return fail('resolution_required')
    if (!(REJECTING_RESOLUTIONS as readonly string[]).includes(t.resolution)) return fail('resolution_invalid')
    // Отказ всегда объясняет себя: заявителю уходит «Ми перевірили: {{resolution_comment}}» (§8)
    if ((t.resolutionComment ?? '').trim().length < RESOLUTION_COMMENT_MIN) return fail('comment_required')
    return { ok: true }
  }

  if (to === 'deferred') {
    if (from !== 'new' && from !== 'in_progress') return fail('invalid_transition')
    if (!t.dueAt) return fail('due_required')
    const days = (t.dueAt.getTime() - t.now.getTime()) / 86_400_000
    if (days <= 0 || days > DEFER_MAX_DAYS) return fail('due_required')
    return { ok: true }
  }

  if (to === 'closed') {
    if (from !== 'fixed') return fail('invalid_transition')
    if (!t.isAdmin) return fail('forbidden')
    // Карточка с неперсчитанными баллами «не может быть тихо закрыта» (§7.7 в)
    if (t.rescoreState === 'needed' || t.rescoreState === 'in_progress') return fail('rescore_pending')
    return { ok: true }
  }

  // В `new` не возвращаются: автоматического переоткрытия нет (§4), ручное ведёт в `in_progress`
  return fail('invalid_transition')
}

/**
 * Итог пересчёта одной попытки по жалобе (§7.8): **результат может только улучшиться**.
 *
 * - `worse` — балл упал или зачёт снялся бы: не применяется ни при каких условиях, попытка
 *   попадает в отдельный список отчёта о пересчёте («отобрать зачтённое нельзя»);
 * - `unchanged` — ни балл, ни зачёт не меняются: записывать нечего;
 * - `improved` — применяется новой записью результата со ссылкой на карточку.
 *
 * «Перерахувати» отчёта по тесту этой функцией не пользуется: там правило другое (D-013 —
 * снятый зачёт откатывает урок и сертификат), и оно не меняется. Логика подсчёта у двух
 * точек входа одна, разная только политика применения.
 */
export function rescoreVerdict(
  before: { score: number | null, passed: boolean | null },
  after: { score: number, passed: boolean | null },
): 'improved' | 'unchanged' | 'worse' {
  const EPS = 0.005
  const beforeScore = before.score ?? 0
  if (before.passed === true && after.passed !== true) return 'worse'
  if (after.score < beforeScore - EPS) return 'worse'
  if (Math.abs(after.score - beforeScore) < EPS && after.passed === before.passed) return 'unchanged'
  return 'improved'
}

/**
 * Когда склейка будит ответственного (§8 `content_issue_merged`): на 3-й и каждой 5-й жалобе.
 * Сорок жалоб на одно битое видео за десять минут не должны дать сорок уведомлений (§12):
 * расписание плюс суточный предел `{max_per_day: 3, per_subject: true}` оставляют три.
 */
export function mergedNotifyDue(reportsCount: number): boolean {
  return reportsCount === 3 || (reportsCount > 3 && reportsCount % 5 === 0)
}

/** Суточный предел `content_issue_merged` на одну карточку (§8: `max_per_day: 3, per_subject: true`). */
export const MERGED_NOTIFY_MAX_PER_DAY = 3

export interface RoutingRuleLite {
  id: string
  sort: number
  targetType: string | null
  issueType: string | null
  categoryId: string | null
  fallback: boolean
  isActive: boolean
}

/**
 * Шаг (а) маршрутизации (§7.5): активные правила, совпавшие по типу элемента, типу проблемы
 * и категории курса, в порядке `sort`. Пустой фильтр правила — «Будь-який». Запасное правило
 * здесь не участвует — оно шаг (г), после авторов и владельца категории.
 *
 * Возвращается весь упорядоченный список, а не первое правило: если адресат первого правила
 * неактивен (уволен, заблокирован), маршрутизация идёт к следующему — уволенный не блокирует.
 */
export function matchingRules<R extends RoutingRuleLite>(
  rules: R[],
  issue: { targetType: string, issueType: string, categoryIds: readonly string[] },
): R[] {
  return rules
    .filter(r => r.isActive && !r.fallback)
    .filter(r => (!r.targetType || r.targetType === issue.targetType)
      && (!r.issueType || r.issueType === issue.issueType)
      && (!r.categoryId || issue.categoryIds.includes(r.categoryId)))
    .sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id))
}

/**
 * Набор правил тенанта после правки (§6.3): «Має бути одне запасне правило». Пустой набор
 * допустим — маршрутизация работает и без правил (шаги б–д). Непустой — ровно одно запасное
 * правило, и оно активно: выключенное запасное правило — то же, что его отсутствие.
 */
export function routingSetValid(rules: Pick<RoutingRuleLite, 'fallback' | 'isActive'>[]): boolean {
  if (rules.length === 0) return true
  const fallbacks = rules.filter(r => r.fallback)
  return fallbacks.length === 1 && fallbacks[0]!.isActive
}

/**
 * «Скарг на 100 проходжень» (§9) — ключ сортировки отчёта «Якість контенту». Нормировка
 * обязательна: без неё в топ попадает самый популярный курс, а не худший (критерий 9 —
 * 2 жалобы на 40 прохождений выше 15 жалоб на 3000). Без прохождений за период число не
 * определено — `null`, такие строки идут после нормированных.
 */
export function perHundred(complaints: number, passes: number): number | null {
  if (passes <= 0) return null
  return Math.round((complaints / passes) * 1000) / 10
}

/** Порядок строк отчёта «Якість контенту»: по жалобам на 100 прохождений, затем по числу жалоб. */
export function compareQuality(
  a: { per100: number | null, complaints: number },
  b: { per100: number | null, complaints: number },
): number {
  if (a.per100 === null && b.per100 !== null) return 1
  if (a.per100 !== null && b.per100 === null) return -1
  if (a.per100 !== null && b.per100 !== null && a.per100 !== b.per100) return b.per100 - a.per100
  return b.complaints - a.complaints
}

/** Действия экрана карточки (§5.4): кнопки, которые видит конкретный человек на конкретной карточке. */
export type ContentIssueAction = 'take' | 'fix' | 'reject' | 'defer' | 'close' | 'reopen' | 'assign' | 'rescore' | 'note' | 'comment'

/**
 * Какие действия доступны (§2, §4, §5.4). Керівник точки видит карточку «без кнопок разбора» —
 * у него остаётся только комментарий. Пересчёт — только у вопроса с резолюцией пересчёта и
 * только у носителя `content_issue.rescore`: автор правит вопрос, но менять выставленные
 * людям результаты может только администратор.
 */
export function availableActions(i: {
  status: ContentIssueStatus
  targetType: ContentIssueTargetType
  resolution: ContentIssueResolution | null
  rescoreState: ContentIssueRescoreState
}, who: { canTriage: boolean, isAdmin: boolean, canRescore: boolean }): ContentIssueAction[] {
  const out: ContentIssueAction[] = ['comment']
  if (who.canTriage) {
    out.push('note')
    if (i.status === 'new') out.push('take', 'reject', 'defer')
    if (i.status === 'in_progress') out.push('fix', 'reject', 'defer')
    if (i.status === 'deferred') out.push('take', 'reject')
  }
  if (who.isAdmin) {
    if (i.status === 'fixed' && i.rescoreState !== 'needed' && i.rescoreState !== 'in_progress') out.push('close')
    if (i.status === 'rejected' || i.status === 'closed') out.push('reopen')
    if (i.status !== 'closed' && i.status !== 'rejected') out.push('assign')
  }
  if (who.canRescore && i.targetType === 'question' && i.resolution
    && (RESCORE_RESOLUTIONS as readonly string[]).includes(i.resolution)
    && (i.rescoreState === 'needed' || i.rescoreState === 'in_progress')) out.push('rescore')
  return out
}
