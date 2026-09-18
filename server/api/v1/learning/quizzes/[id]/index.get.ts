import { requireScope } from '../../../../../services/access'
import { quizIntro } from '../../../../../services/attempts'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** Стартовый экран теста (docs/12 §5.4). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.attempt')
  const enrollmentId = getQuery(event).enrollmentId
  const intro = await quizIntro({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, typeof enrollmentId === 'string' ? enrollmentId : undefined)
  if (!intro) return apiError(event, 404, 'not_found', 'Тест не знайдено')
  return apiData(intro)
})
