import { can, requireScope } from '../../../../services/access'
import { getNotice, viewNotice } from '../../../../services/notices'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** GET /notices/:id — карточка: управляющему (?manage=1) целиком, остальным — только если назначено (иначе 404). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const id = getRouterParam(event, 'id')!
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const r = can(a, 'knowledge.manage') && getQuery(event).manage === '1' ? await getNotice(ctx, id) : await viewNotice(ctx, id)
  if (!r) return apiError(event, 404, 'not_found', 'Оголошення не знайдено')
  return apiData(r)
})
