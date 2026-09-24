import { archiveNotesTenant } from '../services/personNotes'
import { documentsExpiryScanTenant } from '../services/personDocuments'
import type { ExpiryScanStats } from '../services/personDocuments'

/**
 * Ночные задачи карточки человека одного тенанта (docs/v2/38-people-extensions.md §11,
 * план docs/v2/45-plan.md PR-32). Ставятся планировщиком pg-boss и раскладываются по
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
