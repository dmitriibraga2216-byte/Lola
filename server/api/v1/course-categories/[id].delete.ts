import { requireScope } from '../../../services/access'
import { deleteCategory } from '../../../services/categories'
import { apiData, apiError } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.edit')
  const r = await deleteCategory({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) return r.code === 'not_found' ? apiError(event, 404, 'not_found', 'Категорію не знайдено') : apiError(event, 409, 'in_use', 'У категорії є курси або новини — спочатку перенесіть їх', { used: r.used })
  return apiData({ ok: true })
})
