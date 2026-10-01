import { activityReportQuerySchema } from '../../../../shared/schemas/personRecords'
import { areaForScope, can, requireScope } from '../../../services/access'
import { activityExportRows, activityReport } from '../../../services/peopleReports'
import { toCsv } from '../../../services/reportExports'
import { toXlsx } from '../../../services/reports'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * GET /reports/learning-activity — «Навчальна активність» (docs/v2/38 §9 п. 4): дни с событиями,
 * самая длинная серия, события и часы за произвольный период по `user_activity_daily`. Скоуп
 * `person.activity.view_others` в его области (§2). Файл — с `report.export`. Путь `/reports/activity`
 * из `41` занят отчётом «Активність» базового ТЗ (docs/03 §3.9) — имя как у готового отчёта
 * конструктора `learning-activity` (`44` Р-BT.4).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'person.activity.view_others')
  const q = activityReportQuerySchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Перевірте період: початок не пізніше кінця', { issues: q.error.issues })
  const rows = await activityReport({ tenantId: a.tenantId, actorId: a.userId }, await areaForScope(a, 'person.activity.view_others'), q.data)
  if (q.data.format === 'json') return apiData(rows)

  if (!can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження. Зверніться до адміністратора простору')
  const flat = activityExportRows(rows)
  if (q.data.format === 'csv') {
    setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
    setHeader(event, 'Content-Disposition', 'attachment; filename="lola-learning-activity.csv"')
    return toCsv(flat)
  }
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', 'attachment; filename="lola-learning-activity.xlsx"')
  return toXlsx('learning-activity', flat)
})
