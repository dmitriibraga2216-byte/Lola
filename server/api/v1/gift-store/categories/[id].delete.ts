import { requireScope } from '../../../../services/access'
import { deleteShopCategory } from '../../../../services/shop'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** DELETE /gift-store/categories/:id — категорію з товарами не видаляємо: спершу перенесіть товари. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'shop.manage')
  const r = await deleteShopCategory({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) return r.code === 'not_found' ? apiError(event, 404, 'not_found', 'Категорію не знайдено') : apiError(event, 409, 'in_use', 'У категорії є подарунки — спершу перенесіть їх в іншу категорію', { used: r.used })
  return apiData({ ok: true })
})
