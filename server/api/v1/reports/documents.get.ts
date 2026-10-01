import { documentsReportQuerySchema } from '../../../../shared/schemas/personRecords'
import { can, requireAnyScope } from '../../../services/access'
import { docViewerOf } from '../../../services/personDocuments'
import { documentsExportRows, documentsReport } from '../../../services/peopleReports'
import { toCsv } from '../../../services/reportExports'
import { toXlsx } from '../../../services/reports'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * GET /reports/documents — «Документи співробітників» и «Прострочені та близькі до завершення»
 * (`preset=expiring`), docs/v2/38 §9 п. 1–2. Область — `person.document.view_others` или
 * `.manage` (§2): HR и администратор — вся сеть и все типы, руководитель — свои точки и типы
 * `visible_to_manager`. Файл — с `report.export`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, ['person.document.view_others', 'person.document.manage'])
  const q = documentsReportQuerySchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри звіту', { issues: q.error.issues })
  const v = await docViewerOf(a)
  const locations = v.view === 'tenant' || v.manage === 'tenant'
    ? null
    : [...new Set([...(Array.isArray(v.view) ? v.view : []), ...(Array.isArray(v.manage) ? v.manage : [])])]
  const rows = await documentsReport({ tenantId: a.tenantId, actorId: a.userId }, { locations }, q.data)
  if (q.data.format === 'json') return apiData(rows)

  if (!can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження. Зверніться до адміністратора простору')
  const name = q.data.preset === 'expiring' ? 'lola-documents-expiring' : 'lola-documents'
  const flat = documentsExportRows(rows)
  if (q.data.format === 'csv') {
    setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
    setHeader(event, 'Content-Disposition', `attachment; filename="${name}.csv"`)
    return toCsv(flat)
  }
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', `attachment; filename="${name}.xlsx"`)
  return toXlsx('documents', flat)
})
