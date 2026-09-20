import { requireScope } from '../../../services/access'
import { listCategories } from '../../../services/categories'
import { apiData } from '../../../utils/apiResponse'
/** GET /course-categories — «Категорії каталогу навчання» (docs/24 §3.7.1) с порядком. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.view')
  return apiData(await listCategories({ tenantId: a.tenantId, actorId: a.userId }))
})
