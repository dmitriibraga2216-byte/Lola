import { requireScope } from '../../../../../services/access'
import { resourcesByCategory } from '../../../../../services/knowledge'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** GET /knowledge/categories/:id/resources — ресурси категорії (клік по дереву, докс/33 D-041). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const id = getRouterParam(event, 'id')
  if (!id) return apiError(event, 400, 'validation_failed', 'Вкажіть категорію')
  return apiData(await resourcesByCategory({ tenantId: a.tenantId, actorId: a.userId }, id))
})
