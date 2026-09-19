import { z } from 'zod'
import { narrowScope, reportScope, requireScope } from '../../../services/access'
import { competencyMatrix } from '../../../services/developmentExtra'
import { apiData } from '../../../utils/apiResponse'

/** Матриця компетенцій точки (docs/19 §5.6): область видимости — как у отчётов. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.team')
  const q = z.object({ locationId: z.string().uuid().optional() }).parse(getQuery(event))
  const scope = narrowScope(await reportScope(a, 'development.team'), q.locationId)
  return apiData(await competencyMatrix({ tenantId: a.tenantId, actorId: a.userId }, { scope }))
})
