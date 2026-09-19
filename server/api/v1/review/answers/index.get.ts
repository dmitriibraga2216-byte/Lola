import { reviewAnswersQuerySchema } from '../../../../../shared/schemas/quizzes'
import { requireScope } from '../../../../services/access'
import { listReviewAnswers } from '../../../../services/attempts'
import { apiData, apiError } from '../../../../utils/apiResponse'

const bool = (v: unknown) => v === true || v === 'true' || v === '1'

/** Очередь проверки по ответам (docs/12 §14.4): вкладки, метки вопросов, «Поза програмами / курсами», точка. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.queue')
  const q = getQuery(event)
  const tags = q.tags === undefined ? [] : Array.isArray(q.tags) ? q.tags.map(String) : String(q.tags).split(',').filter(Boolean)
  const p = reviewAnswersQuerySchema.safeParse({
    checked: q.checked, tags, outsidePrograms: bool(q.outsidePrograms), outsideCourses: bool(q.outsideCourses),
    locationId: q.locationId || undefined, quizId: q.quizId || undefined, limit: q.limit ? Number(q.limit) : undefined,
  })
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невірний фільтр черги')
  return apiData(await listReviewAnswers({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
