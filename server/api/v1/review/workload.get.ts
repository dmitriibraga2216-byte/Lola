import { reviewWorkloadQuerySchema } from '../../../../shared/schemas/review'
import { requireScope } from '../../../services/access'
import { reviewActorOf } from '../../../services/reviewActor'
import { listWorkload } from '../../../services/reviewWorkload'
import { apiData, apiError } from '../../../utils/apiResponse'

/** GET /review/workload — нагрузка проверяющих области (docs/v2/37 §5.3, §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.workload.view')
  const q = getQuery(event)
  const p = reviewWorkloadQuerySchema.safeParse({ locationId: q.locationId || q.location || undefined })
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Невірний фільтр', { issues: p.error.issues })
  return apiData(await listWorkload(reviewActorOf(a), p.data))
})
