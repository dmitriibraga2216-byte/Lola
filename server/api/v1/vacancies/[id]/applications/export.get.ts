import { vacancyApplicationsExportSchema } from '../../../../../../shared/schemas/vacancies'
import { can, requireScope } from '../../../../../services/access'
import { toCsv } from '../../../../../services/reportExports'
import { toXlsx } from '../../../../../services/reports'
import { viewerOf } from '../../../../../services/vacancies'
import { applicationsExport } from '../../../../../services/vacancyReports'
import { apiError } from '../../../../../utils/apiResponse'

/**
 * GET /vacancies/:id/applications/export — выгрузка откликов (`docs/v2/29` §9.6): CSV/XLSX с
 * контактами. Только `vacancy.view` на весь тенант и `report.export`; факт и число строк — в
 * `audit_log`. Чужая вакансия — `404`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.view')
  const p = vacancyApplicationsExportSchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Формат — xlsx або csv', { issues: p.error.issues })
  const viewer = viewerOf(a)
  if (viewer.locations !== null || !can(a, 'report.export')) {
    return apiError(event, 403, 'forbidden', 'Вивантаження відгуків з контактами — лише з доступом до всіх вакансій і правом на вивантаження')
  }
  const rows = await applicationsExport(viewer, getRouterParam(event, 'id')!, p.data.format)
  if (!rows) return apiError(event, 404, 'not_found', 'Вакансію не знайдено')
  if (p.data.format === 'csv') {
    setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
    setHeader(event, 'Content-Disposition', 'attachment; filename="lola-vacancy-applications.csv"')
    return toCsv(rows)
  }
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', 'attachment; filename="lola-vacancy-applications.xlsx"')
  return toXlsx('vacancy-applications', rows)
})
