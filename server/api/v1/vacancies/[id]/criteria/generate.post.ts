import { requireScope } from '../../../../../services/access'
import { viewerOf } from '../../../../../services/vacancies'
import { generateVacancyCriteria } from '../../../../../services/vacancyAi'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { aiProviderFail, aiUnavailableFail } from '../../../../../utils/aiErrors'

/**
 * POST /vacancies/:id/criteria/generate — «Згенерувати критерії (AI)» (docs/v2/29 §7.11, §10).
 *
 * Черновик: до явного «Зберегти критерії» на фронтенде ни одна строка `vacancy_criteria`
 * не появляется — форма вызывает существующий `POST /vacancies/:id/criteria` по каждой
 * принятой строке (инвариант 18: ИИ не решает, критерии применяет человек).
 *
 * Модель — через шлюз (PR-27): `409 ai.unavailable` при истёкшей или выключенной ИИ-подписке
 * (`docs/v2/35` §7.7 п. 4), `503 ai.provider_failed`, если не ответил ни один профиль.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.ai.use')
  const r = await generateVacancyCriteria(viewerOf(a), getRouterParam(event, 'id')!)
  if (r.ok) return apiData({ criteria: r.criteria, generationId: r.generationId })
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Вакансію не знайдено')
  if (r.code === 'ai_unavailable') return aiUnavailableFail(event, r.reason)
  if (r.code === 'provider_failed') return aiProviderFail(event, r.reason)
  return apiError(event, 409, 'limit_exceeded', 'Ліміт ШІ-операцій вичерпано', { axis: r.check.axis, used: r.check.used, limit: r.check.limit })
})
