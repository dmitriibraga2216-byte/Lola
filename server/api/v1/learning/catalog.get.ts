import { requireScope } from '../../../services/access'
import { catalog } from '../../../services/learning'
import { apiData } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'learn.catalog')
  const q = getQuery(event).q
  return apiData(await catalog(
    { tenantId: access.tenantId, actorId: access.userId },
    typeof q === 'string' ? q : undefined,
  ))
})
