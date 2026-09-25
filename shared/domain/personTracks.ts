/**
 * Блок «Призначені треки» карточки человека (docs/v2/38-people-extensions.md §5.1, §7.15;
 * docs/v2/33-lifecycle.md §5.3 — группировка по этапам; PR-35). Чистые функции: светофор срока
 * считает сервер (`server/services/personTracks.ts`, «сервер считает, клиент показывает»), экран
 * только раскрашивает готовое значение и форматирует время.
 */

/** Светофор «Дедлайн» (§7.15): запас больше 3 дней — бирюза, 3 дня и меньше — солнце, просрочен — коралл. */
export type DeadlineLight = 'none' | 'ok' | 'soon' | 'overdue' | 'done'

export const DEADLINE_SOON_DAYS = 3

/**
 * `none` — срока нет («Без дедлайну», серым); `done` — запись завершена: срок показывается датой
 * без тревоги (просроченным завершённое не бывает, светофор отвечает на вопрос «успеет ли»).
 */
export function deadlineLight(dueAt: string | Date | null | undefined, done: boolean, now: Date = new Date()): DeadlineLight {
  if (done) return 'done'
  if (!dueAt) return 'none'
  const due = typeof dueAt === 'string' ? Date.parse(dueAt) : dueAt.getTime()
  if (!Number.isFinite(due)) return 'none'
  const left = due - now.getTime()
  if (left < 0) return 'overdue'
  return left <= DEADLINE_SOON_DAYS * 86_400_000 ? 'soon' : 'ok'
}

/** «Плановий час: HH:MM:SS» / «Час проходження: HH:MM:SS» (§5.1): часы не сворачиваются в сутки. */
export function formatHms(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return [hh, mm, ss].map(n => String(n).padStart(2, '0')).join(':')
}

// ── Ответ `GET /people/:id/tracks` — один тип на сервер и экран ────────────────────────────

export interface TrackItem {
  enrollmentId: string
  courseId: string
  title: string
  /** `enrollment_status` (docs/02). */
  status: string
  /** `null` — этап без `progress`: показывается факт назначения, а не процент. */
  progressPct: number | null
  assignedAt: string
  /** `null` — срока нет или этап без `deadline`. */
  dueAt: string | null
  light: DeadlineLight
  /** Срок сдвинут с дней отсутствия (docs/v2/38 §7.14). */
  deadlineShifted: boolean
  /** «Пройдено модулів X/Y» — обязательные уроки версии записи (§7.15). */
  modulesDone: number
  modulesTotal: number
  /** `null` — нет нормы ни у одного элемента или время человека смотрящему не видно. */
  plannedSeconds: number | null
  spentSeconds: number | null
}

export interface TrackGroup {
  /** `null` — курсы без этапа. */
  stage: { id: string, name: string, color: string } | null
  /** Плоский список без процента и срока (`progress` выключен у этапа, `33` §5.3). */
  flat: boolean
  showDeadline: boolean
  items: TrackItem[]
}

export interface PersonTracks {
  /** Текущий этап человека — «Онбординг, з 14.03» в шапке карточки (`33` §5.3). */
  current: { stageName: string, color: string, enteredAt: string } | null
  groups: TrackGroup[]
  /** Видно ли смотрящему время человека (`docs/v2/37` §2): иначе метрик времени нет. */
  timeVisible: boolean
}

