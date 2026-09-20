import { requireScope } from '../../../../services/access'
import { categoriesTree } from '../../../../services/knowledge'
import { apiData } from '../../../../utils/apiResponse'

/** GET /knowledge/categories — дерево категорій бази знань для екрана Knowledge (докс/33 D-041). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData(await categoriesTree({ tenantId: a.tenantId, actorId: a.userId }))
})
