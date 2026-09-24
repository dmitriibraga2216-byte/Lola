import { shopItemPatchSchema } from '../../../../../../shared/schemas/gamification'
import { requireScope } from '../../../../../services/access'
import { updateShopItem } from '../../../../../services/shop'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { itemErrorMessage } from '../../../../../utils/shopErrors'

/** PATCH /gift-store/items/:id — правка товару, у тому числі «Опубліковано» і залишок. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'shop.manage')
  const p = shopItemPatchSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля: назва від 2 символів, вартість — ціле число бонусів від 1', { issues: p.error.issues })
  const r = await updateShopItem({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) return apiError(event, r.code === 'not_found' ? 404 : 422, r.code, itemErrorMessage(r.code))
  return apiData({ ok: true })
})
