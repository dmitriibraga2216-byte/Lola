import { requireScope } from '../../../services/access'
import { listBookmarks } from '../../../services/hubExtra'
import { apiData } from '../../../utils/apiResponse'

/** GET /knowledge/bookmarks — «Мої закладки» (docs/21 §14.1). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData(await listBookmarks({ tenantId: a.tenantId, actorId: a.userId }))
})
