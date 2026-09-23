import { reviewQueueQuerySchema } from '../../../../shared/schemas/review'
import { requireScope } from '../../../services/access'
import { listReviewQueue } from '../../../services/reviewQueue'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * Единая очередь проверки поверх `review_queue_items` (docs/v2/37 §10, решение docs/v2/44 В-15).
 *
 * До этого PR путь был алиасом `/review/answers` без фильтров и отдавал голый массив с жёстким
 * `limit 200`. Теперь это самостоятельный список: четыре таба, фильтры экрана `37` §5.1, `total`
 * и ключевой курсор. Три базовых пути остаются узкими фильтрами поверх своих источников —
 * у них есть то, чего у очереди нет (метки вопросов, «Поза програмами», «Поза курсами»).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.queue')
  const q = getQuery(event)
  const bool = (v: unknown) => v === true || v === 'true' || v === '1'
  const p = reviewQueueQuerySchema.safeParse({
    tab: q.tab ?? undefined,
    taskType: q.taskType || undefined,
    locationId: q.locationId || undefined,
    trackId: q.trackId || undefined,
    reviewerId: q.reviewerId || undefined,
    subjectKind: q.subjectKind || undefined,
    from: q.from || undefined,
    to: q.to || undefined,
    overdue: bool(q.overdue),
    cursor: q.cursor || undefined,
    limit: q.limit ? Number(q.limit) : undefined,
  })
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невірний фільтр черги')
  return apiData(await listReviewQueue({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
