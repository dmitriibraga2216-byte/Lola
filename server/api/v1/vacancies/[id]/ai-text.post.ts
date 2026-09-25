import { vacancyAiTextRequestSchema } from '../../../../../shared/schemas/vacancies'
import { requireScope } from '../../../../services/access'
import { viewerOf } from '../../../../services/vacancies'
import { generateVacancyText } from '../../../../services/vacancyAi'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { aiProviderFail, aiUnavailableFail } from '../../../../utils/aiErrors'

/**
 * POST /vacancies/:id/ai-text — «Створити з AI» (docs/v2/29 §7.10, §10, критерии §13 к. 9, 10).
 *
 * Одна генерація = 1 `ai_generate_ops`; при исчерпанном лимите — `409 limit_exceeded` с
 * `details.axis` (решение `docs/v2/44` В-16 — единый код на всю систему, а не именованный
 * `limit.ai_ops_exceeded` из документа). Модель — через шлюз (PR-27): `409 ai.unavailable` при
 * истёкшей или выключенной ИИ-подписке (`docs/v2/35` §7.7 п. 4), `503 ai.provider_failed`, если не
 * ответил ни один профиль; ни то ни другое операцию не списывает.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.ai.use')
  const p = vacancyAiTextRequestSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте дані запиту', { issues: p.error.issues })
  const r = await generateVacancyText(viewerOf(a), getRouterParam(event, 'id')!, p.data)
  if (r.ok) return apiData({ html: r.html, generationId: r.generationId })
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Вакансію не знайдено')
  if (r.code === 'ai_unavailable') return aiUnavailableFail(event, r.reason)
  if (r.code === 'provider_failed') return aiProviderFail(event, r.reason)
  return apiError(event, 409, 'limit_exceeded', 'Ліміт ШІ-операцій вичерпано', { axis: r.check.axis, used: r.check.used, limit: r.check.limit })
})
