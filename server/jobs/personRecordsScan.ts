import { archiveNotesTenant, sensitiveScreenTenant } from '../services/personNotes'
import type { SensitiveScreenStats } from '../services/personNotes'
import { documentsExpiryScanTenant, documentsMissingScanTenant } from '../services/personDocuments'
import type { ExpiryScanStats, MissingScanStats } from '../services/personDocuments'
import { absenceBalanceScanTenant, absenceDeadlineGuardTenant } from '../services/absences'
import type { BalanceScanStats } from '../services/absences'

/**
 * Ночные задачи карточки человека одного тенанта (docs/v2/38-people-extensions.md §11,
 * план docs/v2/45-plan.md PR-32 и PR-33). Ставятся планировщиком pg-boss и раскладываются по
 * тенантам кругом `runPerTenant` (docs/25 §5): падение одного тенанта не трогает остальных.
 */

/** `notes.archive_scan` — ежесуточно 02:00: `archived_at` по сроку хранения §7.6. */
export async function notesArchiveScanTenant(tenantId: string): Promise<number> {
  return archiveNotesTenant(tenantId)
}

/** `documents.expiry_scan` — ежесуточно 06:00: `valid → expiring → expired` и уведомления §8. */
export async function documentsExpiryScan(tenantId: string): Promise<ExpiryScanStats> {
  return documentsExpiryScanTenant(tenantId)
}

/**
 * `absence.deadline_guard` — ежесуточно 05:30 (до `due.scan` в 08:00): сроки обязательных
 * назначений, на которые легло отсутствие, внесённое уже после создания записи (§7.14). При
 * создании назначения и при записи отсутствия тот же сдвиг делается сразу, в их транзакции.
 */
export async function absenceDeadlineGuard(tenantId: string): Promise<number> {
  return absenceDeadlineGuardTenant(tenantId)
}

/** `documents.missing_scan` — ежесуточно 06:10: обязательный документ не внесён 7 дней после приёма (§8). */
export async function documentsMissingScan(tenantId: string): Promise<MissingScanStats> {
  return documentsMissingScanTenant(tenantId)
}

/** `absence.balance_scan` — ежесуточно 05:00: отрицательный остаток отпуска или больничного — HR (§8). */
export async function absenceBalanceScan(tenantId: string): Promise<BalanceScanStats> {
  return absenceBalanceScanTenant(tenantId)
}

/** `notes.sensitive_screen` — еженедельная переборка заметок по текущему словарю скрина (§7.5, §11). */
export async function notesSensitiveScreen(tenantId: string): Promise<SensitiveScreenStats> {
  return sensitiveScreenTenant(tenantId)
}
