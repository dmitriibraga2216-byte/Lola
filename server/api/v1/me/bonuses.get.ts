import { requireScope } from '../../../services/access'
import { myBonuses } from '../../../services/bonuses'
import { apiData } from '../../../utils/apiResponse'

/** GET /me/bonuses (docs/04 §4.4): баланс бонусів, рейтинг, книга операцій людини, «Вистачить на «…»». */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData(await myBonuses({ tenantId: a.tenantId, actorId: a.userId }))
})
