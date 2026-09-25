import { requireScope } from '../../../../../../services/access'
import { viewerOf } from '../../../../../../services/vacancies'
import { acknowledgeAiText } from '../../../../../../services/vacancyAi'
import { apiData, apiError } from '../../../../../../utils/apiResponse'

/** POST /vacancies/:id/ai-text/:gid/acknowledge — «Текст перевірено» (docs/v2/29 §7.9, §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.ai.use')
  const r = await acknowledgeAiText(viewerOf(a), getRouterParam(event, 'id')!, getRouterParam(event, 'gid')!)
  if (r.ok) return apiData(r.vacancy)
  return apiError(event, 404, 'not_found', 'Генерацію не знайдено')
})
