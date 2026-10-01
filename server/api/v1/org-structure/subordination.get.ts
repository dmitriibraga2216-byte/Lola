import { orgSubordinationQuerySchema } from '../../../../shared/schemas/orgStructure'
import { can, reportScope, requireScope } from '../../../services/access'
import { subordinationExportRows, subordinationReport } from '../../../services/orgReports'
import { toCsv } from '../../../services/reportExports'
import { toXlsx } from '../../../services/reports'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * GET /org-structure/subordination — «Підпорядкування людей» (docs/v2/32 §9, `44` Р-OS.6).
 * Скоуп `report.team`: руководитель видит свои точки, `report.tenant` — всю сеть. Файл —
 * `report.export`, формат `csv` (UTF-8 с BOM, `;`) или `xlsx`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.team')
  const q = orgSubordinationQuerySchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри звіту', { issues: q.error.issues })
  const rows = await subordinationReport({ tenantId: a.tenantId, actorId: a.userId }, {
    scope: await reportScope(a), locationId: q.data.locationId, onlyFallback: q.data.onlyFallback, q: q.data.q,
  })
  if (q.data.format === 'json') return apiData(rows)
  if (!can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження. Зверніться до адміністратора простору')
  const flat = subordinationExportRows(rows)
  if (q.data.format === 'csv') {
    setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
    setHeader(event, 'Content-Disposition', 'attachment; filename="lola-org-subordination.csv"')
    return toCsv(flat)
  }
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', 'attachment; filename="lola-org-subordination.xlsx"')
  return toXlsx('org-subordination', flat)
})
