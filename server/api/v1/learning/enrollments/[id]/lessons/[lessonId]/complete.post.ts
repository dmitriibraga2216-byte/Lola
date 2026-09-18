import { requireScope } from '../../../../../../../services/access'
import { completeLesson } from '../../../../../../../services/learning'
import { apiData, apiError } from '../../../../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'learn.view')
  const result = await completeLesson(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'lessonId')!,
  )
  if (!result.ok) {
    if (result.code === 'not_found') return apiError(event, 404, 'not_found', 'Урок не знайдено')
    return apiError(event, 422, 'lesson.conditions_not_met', result.reasons?.[0] ?? 'Умови не виконані', {
      reasons: result.reasons,
    })
  }
  return apiData(result)
})
