import { can, requireScope, scopeForGrants } from '../../../services/access'
import { contentQualityReport } from '../../../services/contentQuality'
import { toXlsx } from '../../../services/reports'
import { apiData, apiError } from '../../../utils/apiResponse'
import { contentQualityQuerySchema } from '../../../../shared/schemas/contentIssues'

/**
 * GET /reports/content-quality — «Якість контенту» (docs/v2/36 §9, §10, критерий 9).
 *
 * Видят керівник точки (по своим точкам), методист и администратор (§2) — скоуп
 * `content_issue.view`. Область видимости не расширяется параметром запроса (docs/22 §7.1):
 * фильтр «точка» только сужает. Выгрузка требует `report.export` и уходит теми же строками,
 * что и экран (docs/22 §7).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'content_issue.view')
  const p = contentQualityQuerySchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте фільтри звіту', { issues: p.error.issues })
  const scope = await scopeForGrants(a, 'content_issue.assign', 'content_issue.view')
  const report = await contentQualityReport({ tenantId: a.tenantId, actorId: a.userId, scope }, p.data)

  if (p.data.format === 'xlsx') {
    if (!can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження')
    setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    setHeader(event, 'Content-Disposition', 'attachment; filename="lola-content-quality.xlsx"')
    return toXlsx('content-quality', report.rows.map(r => ({
      element: r.title,
      type: r.targetType,
      tracks: r.tracks.map(t => t.title).join(', '),
      authors: r.authors.join(', '),
      passes: r.passes,
      complaints: r.complaints,
      per100: r.per100,
      confirmed: r.confirmed,
      rejected: r.rejected,
      avg_days_to_fix: r.avgDaysToFix,
      open_now: r.openNow,
    })))
  }
  return apiData(report)
})
