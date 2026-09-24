import { reviewRevokeSchema } from '../../../../../../shared/schemas/review'
import { requireScope } from '../../../../../services/access'
import { reviewActorOf } from '../../../../../services/reviewActor'
import { revokeDelegation } from '../../../../../services/reviewDelegation'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { REVOKE_ERRORS } from '../../../../../utils/reviewErrors'

/**
 * POST /review/delegations/:id/revoke — «Відкликати делегування» (docs/v2/37 §6.1, §7.6).
 * Автор — пока делегат не открыл карточку; руководитель области — и после, с причиной.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.delegate')
  const p = reviewRevokeSchema.safeParse((await readBody(event)) ?? {})
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Причина — до 500 символів', { issues: p.error.issues })
  const r = await revokeDelegation(reviewActorOf(a), getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    const [status, code, message] = REVOKE_ERRORS[r.code]
    return apiError(event, status, code, message)
  }
  return apiData({ item: r.item })
})
