import type { H3Event } from 'h3'
import { requireScope } from '../../../../../../../services/access'
import { completeLesson } from '../../../../../../../services/learning'
import { apiData, apiError } from '../../../../../../../utils/apiResponse'
import { idempotent } from '../../../../../../../utils/idempotency'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'learn.view')
  // docs/04 §4.1: отметка урока — мутация, которая может повториться (Idempotency-Key)
  return idempotent(event, access, () => complete(event, access))
})

async function complete(event: H3Event, access: { tenantId: string, userId: string }) {
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
}
