import { requireScope } from '../../../services/access'
import { exportOrgStructureCsv } from '../../../services/orgImport'

/**
 * GET /org-structure/export (docs/v2/32 §9, §10): «Оргструктура» — CSV в формате импорта
 * (UTF-8 с BOM, `;`). Импорт, экспорт и откат — одно право `org.structure.import` (`32` §2).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'org.structure.import')
  const csv = await exportOrgStructureCsv({ tenantId: a.tenantId, actorId: a.userId })
  setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
  setHeader(event, 'Content-Disposition', `attachment; filename="org-structure-${new Date().toISOString().slice(0, 10)}.csv"`)
  return csv
})
