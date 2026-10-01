import { vacancyReportQuerySchema } from '../../../../../shared/schemas/vacancies'
import { can, requireScope } from '../../../../services/access'
import { toCsv } from '../../../../services/reportExports'
import { toXlsx } from '../../../../services/reports'
import { viewerOf } from '../../../../services/vacancies'
import { VACANCY_REPORTS } from '../../../../services/vacancyReports'
import type { VacancyReportName } from '../../../../services/vacancyReports'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * GET /reports/vacancies/:name — отчёты вакансий (`docs/v2/29` §9.1–§9.5): `effectiveness`,
 * `boards`, `publications`, `protection`, `ai`. Скоуп `vacancy.view`, область — как у реестра
 * (рекрутер — свои и своих точек). Выгрузка `xlsx`/`csv` — теми же строками, что экран, и
 * требует `report.export` (`docs/22` §7).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.view')
  const name = getRouterParam(event, 'name') as VacancyReportName
  const def = VACANCY_REPORTS[name]
  if (!def) return apiError(event, 404, 'not_found', 'Невідомий звіт')
  const p = vacancyReportQuerySchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте фільтри звіту', { issues: p.error.issues })
  const report = await (def.run as (v: ReturnType<typeof viewerOf>, f: typeof p.data) => Promise<unknown>)(viewerOf(a), p.data)
  if (p.data.format === 'json') return apiData(report)

  if (!can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження. Зверніться до адміністратора простору')
  const rows = (def.rows as (r: unknown) => Record<string, unknown>[])(report)
  if (p.data.format === 'csv') {
    setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
    setHeader(event, 'Content-Disposition', `attachment; filename="lola-vacancies-${name}.csv"`)
    return toCsv(rows)
  }
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', `attachment; filename="lola-vacancies-${name}.xlsx"`)
  return toXlsx(`vacancies-${name}`, rows)
})
