import { ledgerFilterSchema } from '../../../../shared/schemas/gamification'
import { requireAnyScope } from '../../../services/access'
import { ledger } from '../../../services/bonuses'
import { apiError } from '../../../utils/apiResponse'

/** GET /bonuses/ledger (docs/04 §4.13) — «Журнал операцій з бонусами»: книга з залишком у рядку, курсор — id рядка. */
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, ['shop.manage', 'bonus.grant'])
  const q = ledgerFilterSchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри', { issues: q.error.issues })
  const r = await ledger({ tenantId: a.tenantId, actorId: a.userId }, a, q.data)
  if (!r.ok) return apiError(event, 403, 'forbidden', 'Немає доступу')
  return { data: r.rows, meta: { cursor: r.cursor } }
})
