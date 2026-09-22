import { z } from 'zod'
import { requireScope, developmentPlanScope } from '../../../../services/access'
import { listDevelopmentPlans } from '../../../../services/development'
import { apiData } from '../../../../utils/apiResponse'

/** Список планів розвитку (докс/31 `DevelopmentPlans`, докс/28 «Spec 19 (продовження)»). */
const q = z.object({ tab: z.enum(['active', 'inactive', 'done']).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.team')
  const scope = await developmentPlanScope(a)
  return apiData(await listDevelopmentPlans({ tenantId: a.tenantId, actorId: a.userId }, { ...q.parse(getQuery(event)), scope }))
})
