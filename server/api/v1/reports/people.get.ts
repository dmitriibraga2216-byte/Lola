import { peopleReportQuerySchema } from '../../../../shared/schemas/people'
import { reportScope, requireScope } from '../../../services/access'
import { inactiveReport, staffingReport, turnoverReport } from '../../../services/people'
import { apiData, apiError } from '../../../utils/apiResponse'

/** Звіти по людях (docs/16 §9): штат на дату, плинність, неактивні. */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'report.team')
  const parsed = peopleReportQuerySchema.safeParse(getQuery(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Перевірте параметри', { issues: parsed.error.issues })
  const ctx = { tenantId: access.tenantId, actorId: access.userId }
  const q = parsed.data
  const scope = await reportScope(access)
  if (q.kind === 'turnover') {
    const to = q.to ?? new Date().toISOString().slice(0, 10)
    const from = q.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
    return apiData({ kind: 'turnover', from, to, rows: await turnoverReport(ctx, from, to, scope) })
  }
  if (q.kind === 'inactive') return apiData({ kind: 'inactive', days: q.days, rows: await inactiveReport(ctx, q.days, scope) })
  const asOf = q.asOf ?? new Date().toISOString().slice(0, 10)
  return apiData({ kind: 'staffing', asOf, rows: await staffingReport(ctx, asOf, scope) })
})
