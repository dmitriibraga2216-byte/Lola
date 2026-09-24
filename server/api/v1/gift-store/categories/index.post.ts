import { shopCategorySchema } from '../../../../../shared/schemas/gamification'
import { requireScope } from '../../../../services/access'
import { createShopCategory } from '../../../../services/shop'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** POST /gift-store/categories — «Додати нову категорію» (docs/21 §14.3). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'shop.manage')
  const p = shopCategorySchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть назву категорії — до 60 символів', { issues: p.error.issues })
  const r = await createShopCategory({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r.ok) return apiError(event, 409, 'name_taken', 'Категорія з такою назвою вже є')
  return apiData(r.category)
})
