import { areaForScope, can, requireScope } from '../../../services/access'
import { reviewerWorkExportRows, reviewerWorkReport } from '../../../services/reviewReports'
import { toXlsx } from '../../../services/reports'
import { apiData, apiError } from '../../../utils/apiResponse'
import { reviewerWorkReportQuerySchema } from '../../../../shared/schemas/review'

/**
 * GET /reports/reviewers — «Робота перевіряючих» (docs/v2/37 §9.2, `41` §2). Скоуп по `41` —
 * `time.metrics.view`; сверх него — `review.workload.view` (`44` Р-MT.1.3): `time.metrics.view` есть
 * и у наставника, а сравнение проверяющих между собой — сведения руководителя о нагрузке, не
 * наставника. Область — область роли по `review.workload.view`, фильтр «точка» только сужает;
 * работа кандидата — при `candidate.view` (#143). Выгрузка xlsx — `report.export`, теми же строками.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'time.metrics.view')
  if (!can(a, 'review.workload.view')) return apiError(event, 403, 'forbidden', 'Звіт доступний тим, хто бачить навантаження перевіряючих')
  const q = getQuery(event)
  const p = reviewerWorkReportQuerySchema.safeParse(Object.fromEntries(Object.entries(q).filter(([, v]) => v !== '' && v !== undefined)))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте фільтри звіту: дата «по» не раніше дати «з»', { issues: p.error.issues })
  const scope = await areaForScope(a, 'review.workload.view')
  const report = await reviewerWorkReport({ tenantId: a.tenantId, actorId: a.userId, scope, candidates: can(a, 'candidate.view') }, p.data)
  if (p.data.format === 'xlsx') {
    if (!can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження')
    setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    setHeader(event, 'Content-Disposition', 'attachment; filename="lola-reviewers.xlsx"')
    return toXlsx('reviewers', reviewerWorkExportRows(report.rows))
  }
  return apiData(report)
})
