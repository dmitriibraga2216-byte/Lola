/**
 * Правила жалобы на материал (docs/v2/36-content-feedback.md §7.2, §7.4, §7.6, §7.7, §7.10,
 * §7.11). Чистые функции без БД: их же читают unit-тесты и форма жалобы.
 */

import type { ContentIssueSeverity, ContentIssueTargetType, ContentIssueType } from '../enums'
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
