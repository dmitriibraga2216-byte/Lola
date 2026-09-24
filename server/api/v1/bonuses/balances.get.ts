import { balancesFilterSchema } from '../../../../shared/schemas/gamification'
import { requireAnyScope } from '../../../services/access'
import { balances } from '../../../services/bonuses'
import { apiError } from '../../../utils/apiResponse'

/** GET /bonuses/balances — «Керування бонусами» (docs/21 §14.9): люди області з поточною кількістю бонусів. */
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, ['shop.manage', 'bonus.grant'])
  const q = balancesFilterSchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри', { issues: q.error.issues })
  const r = await balances({ tenantId: a.tenantId, actorId: a.userId }, a, q.data)
  if (!r.ok) return apiError(event, 403, 'forbidden', 'Немає доступу')
  return { data: r.rows, meta: { total: r.total, page: q.data.page, perPage: q.data.perPage } }
})
