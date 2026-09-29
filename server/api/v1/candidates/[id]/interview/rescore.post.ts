import { interviewRescoreSchema } from '../../../../../../shared/schemas/interview'
import { requireScope } from '../../../../../services/access'
import { viewerOf } from '../../../../../services/candidates'
import { rescoreInterview } from '../../../../../services/interview/rescore'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { aiProviderFail, aiUnavailableFail } from '../../../../../utils/aiErrors'

/**
 * POST /candidates/:id/interview/rescore — переоценка собеседования с причиной (`docs/v2/30` §10,
 * `41` §2; `interview.override`). Синхронно: ответ — `{aiCallId}` нового вызова модели и итог.
 * Не удалась — прежняя оценка на месте. Решения о человеке нет (инвариант 18): пишется только
 * новая строка `candidate_scores.kind = 'ai'`. Невидимый кандидат — `404` (CLAUDE.md п. 15).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'interview.override')
  const p = interviewRescoreSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте форму', { issues: p.error.issues })
  const r = await rescoreInterview(viewerOf(a), getRouterParam(event, 'id')!, p.data)
  if (r.ok) return apiData(r.rescore)
  switch (r.code) {
    case 'scoring': return apiError(event, 409, 'session.scoring', 'Оцінка вже формується — зачекайте хвилину й оновіть картку')
    case 'not_rescorable': return apiError(event, 409, 'session.not_rescorable', 'Цю співбесіду не можна переоцінити: вона не завершена, згоду відкликано або немає відповідей, придатних для оцінки')
    case 'human_checked': return apiError(event, 409, 'session.human_checked', 'Оцінку вже перевірила людина — переоцінка змінила б те, з чим вона не погодилась. Змініть бал вручну через «Не погоджуюсь»')
    case 'unexplained': return apiError(event, 409, 'session.rescore_unexplained', 'Програма не пояснила нову оцінку цитатами з відповідей. Попередню оцінку збережено — оцініть відповіді самостійно')
    case 'ai_unavailable': return aiUnavailableFail(event, r.reason)
    case 'limit_exceeded': return apiError(event, 409, 'limit_exceeded', 'Ліміт ШІ-співбесід вичерпано — переоцінка можлива після поповнення. Попередню оцінку збережено', {
      axis: r.check.axis, used: r.check.used, limit: r.check.limit,
    })
    case 'provider_failed': return aiProviderFail(event, r.reason)
    default: return apiError(event, 404, 'not_found', 'Кандидата або його співбесіду не знайдено')
  }
})
