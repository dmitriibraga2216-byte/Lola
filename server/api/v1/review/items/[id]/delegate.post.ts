import { reviewDelegateSchema } from '../../../../../../shared/schemas/review'
import { requireScope } from '../../../../../services/access'
import { reviewActorOf } from '../../../../../services/reviewActor'
import { delegateItem } from '../../../../../services/reviewDelegation'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { DELEGATE_ERRORS } from '../../../../../utils/reviewErrors'

/**
 * POST /review/items/:id/delegate — передать работу другому проверяющему (docs/v2/37 §6.1,
 * §7.1–7.3, §10). Делегат становится единственным ответственным; срок проверки не меняется.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.delegate')
  const p = reviewDelegateSchema.safeParse(await readBody(event))
  if (!p.success) {
    const needText = p.error.issues.some(i => i.path[0] === 'reasonText')
    return apiError(event, 422, 'validation_failed', needText ? 'Поясніть причину: 10–500 символів' : 'Оберіть, кому передати, причину і термін', { issues: p.error.issues })
  }
  const r = await delegateItem(reviewActorOf(a), getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    const [status, code, message] = DELEGATE_ERRORS[r.code]
    return apiError(event, status, code, message, r.code.startsWith('due_') ? { field: 'dueAt' } : undefined)
  }
  return apiData({ delegationId: r.delegationId, item: r.item })
})
