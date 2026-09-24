import { shopItemSchema } from '../../../../../shared/schemas/gamification'
import { requireScope } from '../../../../services/access'
import { createShopItem } from '../../../../services/shop'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { itemErrorMessage } from '../../../../utils/shopErrors'

/** POST /gift-store/items — «Додати подарунок» (docs/21 Г-21.1). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'shop.manage')
  const p = shopItemSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля: назва від 2 символів, вартість — ціле число бонусів від 1', { issues: p.error.issues })
  const r = await createShopItem({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r.ok) return apiError(event, 422, r.code, itemErrorMessage(r.code))
  return apiData({ id: r.id })
})
