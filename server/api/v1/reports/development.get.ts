import { z } from 'zod'
import { reportScope, requireScope } from '../../../services/access'
import { externalTrainingReport, gapsReport, goalsReport, promotionReadiness } from '../../../services/developmentExtra'
import { apiData, apiError } from '../../../utils/apiResponse'

/** Отчёты развития (docs/19 §9): розриви, цілі, зовнішнє навчання, готовність до підвищення. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.team')
  const q = z.object({ kind: z.enum(['gaps', 'goals', 'external', 'promotion']).default('gaps'), from: z.string().date().optional(), to: z.string().date().optional(), positionId: z.string().uuid().optional() }).parse(getQuery(event))
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const scope = await reportScope(a)
  switch (q.kind) {
    case 'gaps': return apiData({ kind: q.kind, rows: await gapsReport(ctx, scope) })
    case 'goals': return apiData({ kind: q.kind, rows: await goalsReport(ctx, { from: q.from, to: q.to, scope }) })
    case 'external': return apiData({ kind: q.kind, rows: await externalTrainingReport(ctx, { from: q.from, to: q.to, scope }) })
    case 'promotion': {
      if (!q.positionId) return apiError(event, 400, 'validation_failed', 'Оберіть цільову посаду')
      return apiData({ kind: q.kind, ...(await promotionReadiness(ctx, q.positionId, scope)) })
    }
  }
})
