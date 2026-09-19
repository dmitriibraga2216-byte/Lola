import { requireScope } from '../../../../services/access'
import { personLearning } from '../../../../services/people'
import { apiData } from '../../../../utils/apiResponse'

/** Вкладки «Навчання» й «Атестації» картки (docs/16 §5.2). */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.view')
  return apiData(await personLearning({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!))
})
