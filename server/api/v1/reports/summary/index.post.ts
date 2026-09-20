import { summaryReportSchema } from '../../../../../shared/schemas/reports'
import { locationAccess, narrowScope, reportScope, requireScope } from '../../../../services/access'
import { summaryReport } from '../../../../services/reportSummary'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * Зведений звіт — мастер (docs/22 §13.1, docs/04 `/reports/summary`): шаг `users` | `tasks` | `result`
 * считается на сервере по текущему состоянию мастера; область видимости — как у остальных отчётов.
 */
export default defineEventHandler(async (event) => {
  const p = summaryReportSchema.safeParse((await readBody(event).catch(() => ({}))) ?? {})
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте параметри звіту', { issues: p.error.issues })
  const a = await requireScope(event, 'report.team')
  const visible = await reportScope(a)
  // Точки из выборки людей могут только сузить область; чужой тенант — 404 (CLAUDE.md п. 15)
  let scope = visible
  for (const id of p.data.userFilter.locationIds ?? []) {
    if (await locationAccess(a, visible, id) === 'not_found') return apiError(event, 404, 'not_found', 'Точку не знайдено')
  }
  if (p.data.userFilter.locationIds?.length) scope = visible === null ? p.data.userFilter.locationIds : visible.filter(id => p.data.userFilter.locationIds!.includes(id))
  return apiData(await summaryReport({ tenantId: a.tenantId, actorId: a.userId }, { ...p.data, userFilter: { ...p.data.userFilter, locationIds: undefined }, scope: narrowScope(scope) }))
})
