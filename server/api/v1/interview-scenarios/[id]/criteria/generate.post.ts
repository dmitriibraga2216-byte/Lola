import { requireScope } from '../../../../../services/access'
import { generateScenarioCriteria } from '../../../../../services/interview/criteriaAi'
import { interviewCriteriaGenerateSchema } from '../../../../../../shared/schemas/interview'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { aiProviderFail, aiUnavailableFail } from '../../../../../utils/aiErrors'
import { interviewValidationFail, scenarioFail } from '../../../../../utils/interviewErrors'

/**
 * POST /interview-scenarios/:id/criteria/generate — «Згенерувати критерії (ШІ)» (`docs/v2/30`
 * §6.2, §10; `44` Р-AI2.10). Скоуп — `interview.configure`, как у ручного критерия.
 *
 * Черновик: ответ — предложения, ни одна строка `interview_criteria` не создаётся. Человек
 * проверяет каждое и сохраняет обычным `POST …/criteria` с `source = 'ai_suggested'`
 * (инвариант 18). Модель — через шлюз: `409 limit_exceeded` (ось `ai_generate_ops`, единый код
 * вместо `limit.ai_generate_exhausted` — `41` §8), `409 ai.unavailable`, `503 ai.provider_failed`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'interview.configure')
  const p = interviewCriteriaGenerateSchema.safeParse((await readBody(event).catch(() => null)) ?? {})
  if (!p.success) return interviewValidationFail(event, p.error)
  const r = await generateScenarioCriteria({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.count)
  if (r.ok) return apiData({ criteria: r.criteria, aiCallId: r.aiCallId })
  if (r.code === 'ai_unavailable') return aiUnavailableFail(event, r.reason)
  if (r.code === 'provider_failed') return aiProviderFail(event, r.reason)
  if (r.code === 'limit_exceeded') return apiError(event, 409, 'limit_exceeded', 'Ліміт ШІ-операцій вичерпано. Додайте критерії вручну або збільште ліміт у «Налаштування → Тариф»', { axis: r.check.axis, used: r.check.used, limit: r.check.limit })
  return scenarioFail(event, r.code)
})
