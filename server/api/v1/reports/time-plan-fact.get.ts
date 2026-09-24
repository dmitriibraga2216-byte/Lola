import { can, requireAnyScope, scopeForGrants } from '../../../services/access'
import { planFactExportRows, timePlanFactReport } from '../../../services/timeNorms'
import { toXlsx } from '../../../services/reports'
import { apiData, apiError } from '../../../utils/apiResponse'
import { timePlanFactQuerySchema } from '../../../../shared/schemas/timeNorms'

/**
 * GET /reports/time-plan-fact — «План і факт часу» (docs/v2/37 §9.3, §10), обезличенный: строка —
 * элемент контента, в ответе ни одного человека (§2, §7.14 в). Видят те, кому §2 показывает
 * отклонение план/факт: автор и администратор (`course.edit`) — по всему тенанту, наставник и
 * руководитель (`time.metrics.view`) — по людям своей области. Фильтр «точка» только сужает
 * (docs/22 §7.1). Выгрузка — `report.export`, теми же строками, что и экран (docs/22 §3).
 */
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, ['time.metrics.view', 'course.edit'])
  const p = timePlanFactQuerySchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте фільтри звіту', { issues: p.error.issues })
  const scope = await scopeForGrants(a, 'course.edit', 'time.metrics.view')
  const report = await timePlanFactReport({ tenantId: a.tenantId, actorId: a.userId, scope }, p.data)

  if (p.data.format === 'xlsx') {
    if (!can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження')
    setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    setHeader(event, 'Content-Disposition', 'attachment; filename="lola-time-plan-fact.xlsx"')
    return toXlsx('time-plan-fact', planFactExportRows(report))
  }
  return apiData(report)
})
