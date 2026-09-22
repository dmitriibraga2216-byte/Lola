import { requireScope } from '../../../../../services/access'
import { deleteTreeGoal } from '../../../../../services/development'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** Видалення вузла дерева — каскадом видаляє й піддерево (FK `parent_id ... on delete cascade`). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.manage')
  const ok = await deleteTreeGoal({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!ok) return apiError(event, 404, 'not_found', 'Ціль не знайдено')
  return apiData({ ok: true })
})
