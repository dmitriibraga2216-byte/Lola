import { aiReportQuerySchema } from '../../../../../shared/schemas/ai'
import { can, requireScope } from '../../../../services/access'
import { aiCostReport, aiQualityReport, aiReviewHelpReport, costExportRows, qualityExportRows, reviewHelpExportRows } from '../../../../services/aiReports'
import { toCsv } from '../../../../services/reportExports'
import { toXlsx } from '../../../../services/reports'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * GET /reports/ai/:name — отчёты ИИ (`docs/v2/30` §9.3–§9.5): `quality` — «Якість моделі»,
 * `review-help` — «Допомога перевіряючому», `cost` — «Вартість ШІ». Скоуп `ai.audit` (`30` §2);
 * выгрузка `xlsx`/`csv` — теми же строками, что экран, и требует `report.export` (`docs/22` §7).
 */
const REPORTS = {
  'quality': { run: aiQualityReport, rows: qualityExportRows },
  'review-help': { run: aiReviewHelpReport, rows: reviewHelpExportRows },
  'cost': { run: aiCostReport, rows: costExportRows },
} as const

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'ai.audit')
  const name = getRouterParam(event, 'name') as keyof typeof REPORTS
  const def = REPORTS[name]
  if (!def) return apiError(event, 404, 'not_found', 'Невідомий звіт')
  const p = aiReportQuerySchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте фільтри звіту', { issues: p.error.issues })
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const report = await def.run(ctx, p.data)
  if (p.data.format === 'json') return apiData(report)

  if (!can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження. Зверніться до адміністратора простору')
  const rows = (def.rows as (r: typeof report) => Record<string, unknown>[])(report)
  if (p.data.format === 'csv') {
    setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
    setHeader(event, 'Content-Disposition', `attachment; filename="lola-ai-${name}.csv"`)
    return toCsv(rows)
  }
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', `attachment; filename="lola-ai-${name}.xlsx"`)
  return toXlsx(`ai-${name}`, rows)
})
