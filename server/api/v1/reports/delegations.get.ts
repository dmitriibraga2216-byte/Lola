import { areaForScope, can, requireScope } from '../../../services/access'
import { delegationJournal, delegationJournalExportRows } from '../../../services/reviewReports'
import { toXlsx } from '../../../services/reports'
import { apiData, apiError } from '../../../utils/apiResponse'
import { reviewDelegationJournalQuerySchema } from '../../../../shared/schemas/review'

/**
 * GET /reports/delegations — журнал «Делегування» (docs/v2/37 §9.4, §10). Видит тот, кто видит
 * нагрузку проверяющих (`review.workload.view`), — в области своей роли; фильтр «точка» только
 * сужает. Работа кандидата — только при `candidate.view` (#143). Выгрузка xlsx — `report.export`,
 * теми же строками, что и экран (docs/22 §3).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.workload.view')
  const q = getQuery(event)
  const p = reviewDelegationJournalQuerySchema.safeParse(Object.fromEntries(Object.entries(q).filter(([, v]) => v !== '' && v !== undefined)))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте фільтри журналу', { issues: p.error.issues })
  const scope = await areaForScope(a, 'review.workload.view')
  const journal = await delegationJournal({ tenantId: a.tenantId, actorId: a.userId, scope, candidates: can(a, 'candidate.view') }, p.data)
  if (p.data.format === 'xlsx') {
    if (!can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження')
    setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    setHeader(event, 'Content-Disposition', 'attachment; filename="lola-delegations.xlsx"')
    return toXlsx('delegations', delegationJournalExportRows(journal.rows))
  }
  return apiData(journal)
})
