/**
 * Правила ленты и карты активности (docs/v2/38-people-extensions.md §5.1, §7.9–§7.11; PR-34).
 * Чистые функции без Vue и Nitro: ими пользуются сервер (`server/services/activity.ts` — уровень
 * дня и окно наставника) и экран (`app/components/PersonActivityMap.vue` — сетка года). Из `app/**`
 * импортировать через `#shared/domain/activity`, из `server/**` — относительным путём (урок #108,
 * шапка `shared/domain/dateFormat.ts`).
 *
 * «Сервер считает, клиент показывает»: уровень дня хранит `user_activity_daily.level`, сетка лишь
 * раскладывает готовые дни по неделям — день и уровень она не вычисляет заново.
 */

import type { UserActivityKind } from '../enums'

/**
 * Кто порождает событие и на что оно ссылается (§7.9, Р-34.6). `owner` — в чью ленту ложится:
 * ученик; проверяющий (его учебная работа — проверка); заполнивший чек-лист; автор замечания.
 * `refs` — таблицы источника (`ref_entity`); `tests/unit/user-activity.spec.ts` сверяет каждый
 * вызов `recordActivity()` в `server/` с этой таблицей, и каждый вид обязан где-то порождаться.
 * Вне списка (не события по §7.9 или не названы в нём): вход, открытие урока без зачёта,
 * просмотр материала вне курса, посещение занятия вне курса, «Ознайомлений» по оголошенню,
 * анкета оценки — расширение списка только через docs/02 (CLAUDE.md п. 13).
 */
export const ACTIVITY_SOURCES: Record<UserActivityKind, { owner: 'learner' | 'reviewer' | 'runner' | 'reporter', refs: readonly string[] }> = {
  lesson_completed: { owner: 'learner', refs: ['lessons'] },
  attempt_submitted: { owner: 'learner', refs: ['attempts'] },
  attempt_graded: { owner: 'learner', refs: ['attempts'] },
  enrollment_started: { owner: 'learner', refs: ['enrollments'] },
  enrollment_completed: { owner: 'learner', refs: ['enrollments'] },
  workshop_submitted: { owner: 'learner', refs: ['workshop_submissions'] },
  checklist_run_completed: { owner: 'runner', refs: ['checklist_runs'] },
  knowledge_read: { owner: 'learner', refs: ['knowledge_articles'] },
  survey_submitted: { owner: 'learner', refs: ['survey_participations'] },
  certificate_issued: { owner: 'learner', refs: ['certificates'] },
  review_graded: { owner: 'reviewer', refs: ['attempt_answers', 'workshop_submissions'] },
  content_issue_accepted: { owner: 'reporter', refs: ['content_issues'] },
}

/** События хранятся 400 дней (§7.11): 365 дней карты плюс запас на поздние записи и високосный год. */
export const ACTIVITY_RETENTION_DAYS = 400

/** Наставник видит ленту человека из своей очереди проверки только за последние 90 дней (§7.11). */
export const REVIEWER_ACTIVITY_DAYS = 90

/**
 * Пороги уровня по **числу событий**, не по времени (§7.10 [решение]): 0 — нет; 1 — 1–2; 2 — 3–5;
 * 3 — 6–10; 4 — больше 10. Время подвержено «відкрив і пішов», число завершённых действий — нет.
 * Верхние границы уровней 1…3; та же лесенка собирается в SQL (`levelSql()` на сервере).
 */
export const ACTIVITY_LEVEL_BOUNDS = [2, 5, 10] as const

export type ActivityLevel = 0 | 1 | 2 | 3 | 4

/** Уровни и ключи легенды «Немає · Невелика · Середня · Висока · Дуже висока» (§5.1). */
export const ACTIVITY_LEVELS = [0, 1, 2, 3, 4] as const satisfies readonly ActivityLevel[]
export const ACTIVITY_LEVEL_KEYS = ['none', 'low', 'medium', 'high', 'veryHigh'] as const

export function activityLevel(eventsCount: number): ActivityLevel {
  if (!Number.isFinite(eventsCount) || eventsCount <= 0) return 0
  const i = ACTIVITY_LEVEL_BOUNDS.findIndex(bound => eventsCount <= bound)
  return (i === -1 ? 4 : i + 1) as ActivityLevel
}

/** Время в подсказке клетки — «{HH:MM} у навчанні» (§5.1): часы не сворачиваются в сутки. */
export function formatHoursMinutes(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** Пояс в форме IANA (`Europe/Kyiv`, `Asia/Dubai`, `UTC`), который знает среда выполнения. */
export function isIanaTimezone(value: string): boolean {
  if (!/^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(value)) return false
  try {
    // Без локали: проверяется только пояс, форматирования здесь нет
    new Intl.DateTimeFormat(undefined, { timeZone: value })
    return true
  }
  catch {
    return false
  }
}

/** День карты с сервера: локальная дата человека `YYYY-MM-DD` и готовые числа. */
export interface ActivityDay {
  date: string
  count: number
  seconds: number
  level: ActivityLevel
  kinds: Record<string, number>
}

/** Клетка сетки: `date: null` — клетка вне года (хвост первой и последней недели). */
export interface ActivityCell {
  date: string | null
  /** Вне окна, доступного смотрящему (наставник — 90 дней), или в будущем: клетка приглушена. */
  muted: boolean
  day: ActivityDay | null
}

const pad = (n: number) => String(n).padStart(2, '0')
const isoOf = (t: number) => {
  const d = new Date(t)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
const DAY_MS = 86_400_000

/**
 * Сетка года «недели × 7 дней» (§5.1): колонка — неделя с понедельника, строка — день недели.
 * Даты календарные, без часового пояса (день уже локальный — его посчитал сервер), поэтому
 * арифметика только в UTC: иначе пояс браузера сдвинул бы клетку на день. Колонок 53, изредка 54
 * (високосный год, начавшийся в воскресенье).
 *
 * `from` / `to` — доступное окно (включительно): клетки вне него приглушены, данных в них нет.
 */
export function yearGrid(year: number, days: readonly ActivityDay[], window: { from?: string | null, to?: string | null } = {}): ActivityCell[][] {
  const byDate = new Map(days.map(d => [d.date, d]))
  const start = Date.UTC(year, 0, 1)
  const end = Date.UTC(year, 11, 31)
  const shift = (new Date(start).getUTCDay() + 6) % 7 // понедельник — 0
  const weeks: ActivityCell[][] = []
  for (let t = start - shift * DAY_MS; t <= end; t += 7 * DAY_MS) {
    const week: ActivityCell[] = []
    for (let i = 0; i < 7; i++) {
      const cur = t + i * DAY_MS
      if (cur < start || cur > end) {
        week.push({ date: null, muted: true, day: null })
        continue
      }
      const date = isoOf(cur)
      const muted = (!!window.from && date < window.from) || (!!window.to && date > window.to)
      week.push({ date, muted, day: muted ? null : byDate.get(date) ?? null })
    }
    weeks.push(week)
  }
  return weeks
}
