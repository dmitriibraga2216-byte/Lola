import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { startAttempt } from '../../../../../services/attempts'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { clientIp } from '../../../../../utils/authCookies'

const body = z.object({
  enrollmentId: z.string().uuid().optional(),
  lessonId: z.string().uuid().optional(),
  device: z.enum(['mobile', 'desktop']).optional(),
}).default({})

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.attempt')
  const p = body.parse((await readBody(event).catch(() => ({}))) ?? {})
  const r = await startAttempt({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, { ...p, ip: clientIp(event) })
  if (!r.ok) {
    switch (r.code) {
      case 'not_found': return apiError(event, 404, 'not_found', 'Тест не знайдено')
      case 'in_progress': return apiData({ attemptId: r.attemptId, resumed: true })
      case 'attempts_exhausted': return apiError(event, 422, 'quiz.attempts_exhausted', 'Спроби вичерпано')
      case 'cooldown': return apiError(event, 422, 'quiz.cooldown', 'Зачекайте перед наступною спробою', { retryAt: r.retryAt })
      case 'not_enough_questions': return apiError(event, 422, 'quiz.not_enough_questions', 'У тесті недостатньо питань')
      // docs/v2/30 §7.4, §13 к. 1: тест-співбесіда стартує тільки після рішення щодо згоди
      case 'interview_required': return apiError(event, 409, 'interview_consent.required', 'Спочатку потрібна згода на запис співбесіди — відкрийте співбесіду зі свого навчання', { quizId: getRouterParam(event, 'id') })
    }
  }
  return apiData({ attemptId: r.attemptId, attemptNo: r.attemptNo, deadlineAt: r.deadlineAt, resumed: false })
})
