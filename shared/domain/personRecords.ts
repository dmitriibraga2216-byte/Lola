/**
 * Правила заметок и документов человека (docs/v2/38-people-extensions.md §4, §7.4–§7.8).
 * Чистые функции без БД: их читают сервисы, форма карточки и unit-тесты.
 */

import type { PersonDocumentStatus, PersonNoteCategory, PersonNoteVisibility } from '../enums'
import { PERSON_DOCUMENT_LIMITS, PERSON_NOTE_LIMITS, PERSON_NOTE_LONG_RETENTION } from '../enums'

// ── Заметки ─────────────────────────────────────────────────────────────────────────────

/**
 * Срок хранения заметки в месяцах (§7.6): 24 для обычных категорий, 36 для `training_plan`,
 * `agreement` и любой закреплённой — договорённость о развитии переживает годовой цикл
 * аттестации. По истечении `notes.archive_scan` ставит `archived_at`.
 */
export function noteRetentionMonths(category: PersonNoteCategory, isPinned: boolean): number {
  return isPinned || PERSON_NOTE_LONG_RETENTION.includes(category)
    ? PERSON_NOTE_LIMITS.retentionMonthsLong
    : PERSON_NOTE_LIMITS.retentionMonths
}

/** Дата, после которой заметка уходит в архив (§7.6): `created_at + срок`. */
export function noteArchiveAfter(createdAt: Date, category: PersonNoteCategory, isPinned: boolean): Date {
  const d = new Date(createdAt)
  d.setUTCMonth(d.getUTCMonth() + noteRetentionMonths(category, isPinned))
  return d
}

/**
 * Можно ли сменить видимость (§4): меняется в обе стороны, **кроме** `shared_with_person →
 * manager | hr`. Открытое человеку он уже прочитал — «спрятать» показанное нельзя, иначе
 * заметка становится инструментом, а не записью (`409 visibility_narrowing_forbidden`).
 */
export function isVisibilityNarrowing(from: PersonNoteVisibility, to: PersonNoteVisibility): boolean {
  return from === 'shared_with_person' && to !== 'shared_with_person'
}

/** Текст заметки после нормализации: пробелы по краям не считаются содержанием (§6.1). */
export function normalizeNoteBody(body: string): string {
  return body.replace(/\r\n/g, '\n').trim()
}

// ── Документы ───────────────────────────────────────────────────────────────────────────

/** ISO-дата `YYYY-MM-DD` без времени: документы живут датами, не моментами. */
export type IsoDate = string

/** Разница в целых днях `to − from` по календарным датам (без часовых поясов). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/** `date + months` календарно, с зажимом дня в границы месяца (31.01 + 1 = 28/29.02). */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const total = (y * 12 + (m - 1)) + months
  const ny = Math.floor(total / 12)
  const nm = total % 12
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate()
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

/**
 * Состояние документа по сроку (§4): без `expires_at` — `valid` всегда; после даты —
 * `expired`; в окне напоминаний (самое раннее из `remind_days`, по умолчанию 30 дней) —
 * `expiring`. В день истечения документ ещё действителен: «Дійсний до 12.03» включает 12.03.
 * `revoked` сюда не попадает — его ставит человек, а не срок.
 */
export function documentStatusBy(expiresAt: IsoDate | null, today: IsoDate, remindDays: readonly number[]): Exclude<PersonDocumentStatus, 'revoked'> {
  if (!expiresAt) return 'valid'
  const left = daysBetween(today, expiresAt)
  if (left < 0) return 'expired'
  const window = remindDays.length ? Math.max(...remindDays) : 0
  return left <= window ? 'expiring' : 'valid'
}

/**
 * Надо ли сегодня напомнить об истекающем документе (§7.8): в день перехода в `expiring`
 * и в каждый из дней `remind_days` (30, 7, 0 до `expires_at`); после истечения — ежедневно
 * ещё 14 дней, затем тишина: бесконечное напоминание игнорируется.
 */
export function documentReminderDue(expiresAt: IsoDate, today: IsoDate, remindDays: readonly number[], justBecameExpiring: boolean): 'expiring' | 'expired' | null {
  const left = daysBetween(today, expiresAt)
  if (left < 0) return -left <= PERSON_DOCUMENT_LIMITS.expiredReminderDays ? 'expired' : null
  if (justBecameExpiring || remindDays.includes(left)) return 'expiring'
  return null
}

/**
 * Маскированный номер (§7.7): хранятся только последние 4 знака — факт наличия документа,
 * а не его содержание. `****1234` укладывается в `number_masked ≤ 8`.
 */
export function maskDocumentNumber(number: string | null | undefined): string | null {
  const clean = (number ?? '').replace(/\s+/g, '')
  if (!clean) return null
  return `****${clean.slice(-PERSON_DOCUMENT_LIMITS.numberKeep)}`
}

export type DocumentDatesError = 'issued_in_future' | 'expires_before_issued' | 'expires_required'

/**
 * Проверка дат формы (§6.2): «Виданий» — не в будущем; «Дійсний до» — позже даты видачі и
 * обязателен, если у типа есть `validity_months`. Истёкший при загрузке документ **не
 * ошибка** (§12): HR вносит исторические записи, он просто сразу `expired`.
 */
export function validateDocumentDates(input: { issuedAt: IsoDate, expiresAt: IsoDate | null }, today: IsoDate, validityMonths: number | null): DocumentDatesError | null {
  if (daysBetween(today, input.issuedAt) > 0) return 'issued_in_future'
  if (input.expiresAt && daysBetween(input.issuedAt, input.expiresAt) <= 0) return 'expires_before_issued'
  if (validityMonths && !input.expiresAt) return 'expires_required'
  return null
}

/**
 * Срок хранения файла документа (§7.8): `expires_at + 3 роки` — общий срок исковой давности
 * по трудовым спорам; бессрочный документ — без срока (`null`), его судьбу решает человек.
 */
export function documentRetentionUntil(expiresAt: IsoDate | null): IsoDate | null {
  return expiresAt ? addMonths(expiresAt, PERSON_DOCUMENT_LIMITS.retentionYearsAfterExpiry * 12) : null
}

/**
 * Замещает ли новый документ того же типа прежний (§4, §12 «Два документа одного типа
 * подряд»). Тип-«состояние» — обязательный или со сроком действия: у человека ровно один
 * действующий инструктаж, одна медкнижка, один договор. Тип-«коллекция» — ни того ни
 * другого («Сертифікат стороннього навчання», «Інше»): сертификатов за разные курсы у
 * человека много, и второй не отменяет первый.
 */
export function documentTypeIsSingular(type: { isRequired: boolean, validityMonths: number | null }): boolean {
  return type.isRequired || type.validityMonths != null
}

/**
 * Кто из двух документов одного типа остаётся действующим (§4): более свежий по дате выдачи.
 * Историческая запись, внесённая после текущей, не должна отменить текущую — она сама
 * становится отменённой, «заменённой» более свежим.
 */
export function newerDocumentWins(existingIssuedAt: IsoDate | null, incomingIssuedAt: IsoDate): 'incoming' | 'existing' {
  if (!existingIssuedAt) return 'incoming'
  return daysBetween(existingIssuedAt, incomingIssuedAt) >= 0 ? 'incoming' : 'existing'
}

/** Обязателен ли тип для человека (§7.8): пустой `required_positions` — для всех посад. */
export function documentRequiredFor(type: { isRequired: boolean, isActive: boolean, requiredPositions: readonly string[] }, positionIds: readonly string[]): boolean {
  if (!type.isRequired || !type.isActive) return false
  return type.requiredPositions.length === 0 || type.requiredPositions.some(p => positionIds.includes(p))
}

/** Допустим ли файл документа (§6.2): PDF, JPG, PNG до 20 МБ. */
export function documentFileAllowed(mime: string, bytes: number): boolean {
  return (PERSON_DOCUMENT_LIMITS.fileMimes as readonly string[]).includes(mime) && bytes <= PERSON_DOCUMENT_LIMITS.fileMaxMb * 1024 * 1024
}
