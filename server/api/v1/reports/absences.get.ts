import { absenceNormsReportQuerySchema } from '../../../../shared/schemas/personRecords'
import { areaForScope, can, requireScope } from '../../../services/access'
import { absenceNormsExportRows, absenceNormsReport } from '../../../services/peopleReports'
import { toCsv } from '../../../services/reportExports'
import { toXlsx } from '../../../services/reports'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * GET /reports/absences — «Норми і залишки відсутностей» (docs/v2/38 §9 п. 3). Скоуп
 * `person.absence.manage` в его области (руководитель — свои точки, HR — вся сеть, §2).
 * Файл — с `report.export`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'person.absence.manage')
  const q = absenceNormsReportQuerySchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри звіту', { issues: q.error.issues })
  const rows = await absenceNormsReport({ tenantId: a.tenantId, actorId: a.userId }, await areaForScope(a, 'person.absence.manage'), q.data)
  if (q.data.format === 'json') return apiData(rows)

  if (!can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження. Зверніться до адміністратора простору')
  const flat = absenceNormsExportRows(rows)
  if (q.data.format === 'csv') {
    setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
    setHeader(event, 'Content-Disposition', 'attachment; filename="lola-absence-norms.csv"')
    return toCsv(flat)
  }
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', 'attachment; filename="lola-absence-norms.xlsx"')
  return toXlsx('absence-norms', flat)
})
