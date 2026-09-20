import { requireScope } from '../../../services/access'
import { deleteResourceCategory } from '../../../services/resources'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.edit')
  const ok = await deleteResourceCategory({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!ok) return apiError(event, 404, 'not_found', 'Категорію не знайдено')
  return apiData({ ok: true })
})
