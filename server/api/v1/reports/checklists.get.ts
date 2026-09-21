import { z } from 'zod'
import { can, narrowScope, reportScope, requireScope } from '../../../services/access'
import { checklistItemsReport, checklistLocationsReport, checklistPeopleReport, checklistReport, disciplineReport } from '../../../services/checklists'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.team')
  const q = z.object({ from: z.string().date().optional(), to: z.string().date().optional(), locationId: z.string().uuid().optional(), checklistId: z.string().uuid().optional() }).parse(getQuery(event))
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const scope = narrowScope(await reportScope(a), q.locationId)
  const filter = { ...q, scope, canSeeUnpublished: can(a, 'report.tenant') }
  return apiData({
    ...(await checklistReport(ctx, filter)),
    discipline: await disciplineReport(ctx, scope),
    items: await checklistItemsReport(ctx, filter),
    locations: await checklistLocationsReport(ctx, filter),
    people: await checklistPeopleReport(ctx, filter),
  })
})
