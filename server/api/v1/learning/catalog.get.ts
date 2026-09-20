import { requireScope } from '../../../services/access'
import { catalog } from '../../../services/learning'
import { apiData } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'learn.catalog')
  const query = getQuery(event)
  return apiData(await catalog(
    { tenantId: access.tenantId, actorId: access.userId },
    {
      q: typeof query.q === 'string' ? query.q : undefined,
      categoryId: typeof query.category === 'string' ? query.category : undefined,
    },
  ))
})
