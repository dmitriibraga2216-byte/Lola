import { interviewReportQuerySchema } from '../../../../../shared/schemas/interview'
import { can, requireScope } from '../../../../services/access'
import { viewerOf } from '../../../../services/candidates'
import {
  consentExportRows, funnelExportRows, interviewConsentReport, interviewFunnelReport, interviewSessionsReport, sessionsExportRows,
} from '../../../../services/interviewReports'
import { toCsv } from '../../../../services/reportExports'
import { toXlsx } from '../../../../services/reports'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * GET /reports/interviews/:name — отчёты ИИ-собеседования (`docs/v2/30` §9.1, §9.2, §9.6):
 * `funnel` — «Воронка співбесід», `consents` — «Згоди», `sessions` — «Вивантаження співбесід».
 * Скоуп `interview.view` (`30` §2), кандидаты — в области зрителя. Файл (`xlsx`/`csv`) — теми же
 * строками и с `report.export` (`docs/22` §7); выгрузка сессий пишет `audit_log` с числом строк.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'interview.view')
  const name = getRouterParam(event, 'name')
  if (name !== 'funnel' && name !== 'consents' && name !== 'sessions') return apiError(event, 404, 'not_found', 'Невідомий звіт')
  const p = interviewReportQuerySchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте фільтри звіту', { issues: p.error.issues })
  const v = viewerOf(a)
  const file = p.data.format !== 'json'
  if (file && !can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження. Зверніться до адміністратора простору')

  let rows: Record<string, unknown>[]
  if (name === 'funnel') {
    const r = await interviewFunnelReport(v, p.data)
    if (!file) return apiData(r)
    rows = funnelExportRows(r)
  }
  else if (name === 'consents') {
    const r = await interviewConsentReport(v, p.data)
    if (!file) return apiData(r)
    rows = consentExportRows(r)
  }
  else {
    const r = await interviewSessionsReport(v, p.data, file ? { audit: { format: p.data.format } } : {})
    if (!file) return apiData(r)
    rows = sessionsExportRows(r)
  }

  if (p.data.format === 'csv') {
    setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
    setHeader(event, 'Content-Disposition', `attachment; filename="lola-interviews-${name}.csv"`)
    return toCsv(rows)
  }
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', `attachment; filename="lola-interviews-${name}.xlsx"`)
  return toXlsx(`interviews-${name}`, rows)
})
