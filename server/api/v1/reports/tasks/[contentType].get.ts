import { taskReportContentTypeSchema, taskReportQuerySchema } from '../../../../../shared/schemas/reports'
import { can, locationAccess, narrowScope, reportScope, requireScope } from '../../../../services/access'
import { TASK_REPORT_TYPES, taskReport, taskReportRows } from '../../../../services/reportTasks'
import { toXlsx } from '../../../../services/reports'
import { logSecurity } from '../../../../services/securityLog'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * Отчёт по типу контента (docs/22 §13.2, §13.7; docs/04 `/reports/tasks/:contentType?taskId=`): один экран на тип,
 * назначение или предмет — фильтром; область видимости — как у всех отчётов (§2), чужая точка — 404 (CLAUDE.md п. 15).
 */
export default defineEventHandler(async (event) => {
  const ct = taskReportContentTypeSchema.safeParse(getRouterParam(event, 'contentType'))
  if (!ct.success) return apiError(event, 404, 'not_found', 'Невідомий тип контенту')
  const a = await requireScope(event, 'report.team')
  if (!TASK_REPORT_TYPES.includes(ct.data)) return apiError(event, 422, 'report.unsupported', 'Звіт для цього типу контенту ще не будується — оберіть курс, програму або тест')
  const q = taskReportQuerySchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри', { issues: q.error.issues })
  const visible = await reportScope(a)
  const la = q.data.locationId ? await locationAccess(a, visible, q.data.locationId) : 'ok'
  if (la === 'not_found') return apiError(event, 404, 'not_found', 'Точку не знайдено')
  const f = { ...q.data, scope: narrowScope(visible, q.data.locationId) }
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  if (q.data.format === 'xlsx') {
    if (!can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження')
    const rows = await taskReportRows(ctx, ct.data, f)
    // docs/22 §11: выгрузка с персональными данными — в журнал безопасности
    await logSecurity({ tenantId: a.tenantId, userId: a.userId, event: 'export.personal_data', meta: { report: `tasks:${ct.data}`, rows: rows.length } })
    setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    setHeader(event, 'Content-Disposition', `attachment; filename="lola-tasks-${ct.data}.xlsx"`)
    return toXlsx(`tasks-${ct.data}`, rows)
  }
  const r = await taskReport(ctx, ct.data, f)
  if ('error' in r) return r.error === 'not_found' ? apiError(event, 404, 'not_found', 'Завдання не знайдено') : apiError(event, 422, 'report.unsupported', 'Звіт для цього типу контенту ще не будується')
  return apiData(r)
})
