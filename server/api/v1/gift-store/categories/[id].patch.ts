import { shopCategorySchema } from '../../../../../shared/schemas/gamification'
import { requireScope } from '../../../../services/access'
import { updateShopCategory } from '../../../../services/shop'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** PATCH /gift-store/categories/:id — перейменувати категорію. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'shop.manage')
  const p = shopCategorySchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть назву категорії — до 60 символів', { issues: p.error.issues })
  const r = await updateShopCategory({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) return r.code === 'not_found' ? apiError(event, 404, 'not_found', 'Категорію не знайдено') : apiError(event, 409, 'name_taken', 'Категорія з такою назвою вже є')
  return apiData(r.category)
})
