import { z } from 'zod'
import { can, narrowScope, reportScope, requireScope } from '../../../services/access'
import { checklistReport, disciplineReport } from '../../../services/checklists'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.team')
  const q = z.object({ from: z.string().date().optional(), to: z.string().date().optional(), locationId: z.string().uuid().optional(), checklistId: z.string().uuid().optional() }).parse(getQuery(event))
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const scope = narrowScope(await reportScope(a), q.locationId)
  return apiData({ ...(await checklistReport(ctx, { ...q, scope, canSeeUnpublished: can(a, 'report.tenant') })), discipline: await disciplineReport(ctx, scope) })
})
