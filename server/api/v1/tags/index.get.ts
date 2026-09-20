import { tagListQuerySchema } from '../../../../shared/schemas/people'
import { requireScope } from '../../../services/access'
import { listTags } from '../../../services/tags'
import { apiData, apiError } from '../../../utils/apiResponse'

/** GET /tags?scope= — метки области со счётчиком использований (docs/04 §4.11, docs/16 §14.2). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'people.view')
  const q = tagListQuerySchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Невідома область дії')
  return apiData(await listTags({ tenantId: a.tenantId, actorId: a.userId }, q.data.scope))
})
