import { funnelReportSchema } from '../../../../shared/schemas/candidates'
import { requireScope } from '../../../services/access'
import { viewerOf } from '../../../services/candidates'
import { funnelReport } from '../../../services/candidateFunnel'
import { toXlsx } from '../../../services/reports'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * GET /reports/recruiting-funnel — отчёт по воронке (docs/v2/28 §9 п. 1, §10).
 *
 * Скоуп — `candidate.view`: отчёт по кандидатам читает тот, кто вправе видеть кандидатов, а
 * не любой, у кого есть `report.team`. Левая часть списка людей — единый каркас колонок
 * (docs/22 §13.3), тот же, что у всех отчётов репозитория; отличие одно — вид человека
 * `candidate` (`reportFrame.frameWhere({ kind })`, П-16.1).
 *
 * Выгрузка требует `report.export` и уходит теми же цифрами, что и экран (docs/22 §7).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.view')
  const p = funnelReportSchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте фільтри звіту', { issues: p.error.issues })
  const report = await funnelReport(viewerOf(a), p.data)

  if (p.data.format === 'xlsx') {
    const { can } = await import('../../../services/access')
    if (!can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження')
    setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    setHeader(event, 'Content-Disposition', 'attachment; filename="lola-recruiting-funnel.xlsx"')
    return toXlsx('recruiting-funnel', report.rows)
  }
  return apiData(report)
})
