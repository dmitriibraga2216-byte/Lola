import { reviewReassignSchema } from '../../../../../../shared/schemas/review'
import { requireScope } from '../../../../../services/access'
import { reviewActorOf } from '../../../../../services/reviewActor'
import { reassignItem } from '../../../../../services/reviewDelegation'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { REASSIGN_ERRORS } from '../../../../../utils/reviewErrors'

/** POST /review/items/:id/reassign — «Переназначити» (docs/v2/37 §5.1, §10), только `review.delegate.any`. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.delegate.any')
  const p = reviewReassignSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Оберіть, кому передати, і вкажіть причину', { issues: p.error.issues })
  const r = await reassignItem(reviewActorOf(a), getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    const [status, code, message] = REASSIGN_ERRORS[r.code]
    return apiError(event, status, code, message)
  }
  return apiData({ item: r.item })
})
