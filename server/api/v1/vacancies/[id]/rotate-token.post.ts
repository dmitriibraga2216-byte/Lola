import { requireScope } from '../../../../services/access'
import { rotateToken, viewerOf } from '../../../../services/vacancies'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /vacancies/:id/rotate-token — «Оновити посилання» (docs/v2/29 §7.8, §10).
 * Старый токен умирает немедленно: кнопка существует ради всплеска ботов, а отложенная
 * смена ссылки такой всплеск не останавливает.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.publish')
  const r = await rotateToken(viewerOf(a), getRouterParam(event, 'id')!)
  if (r.ok) return apiData(r.vacancy)
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Вакансію не знайдено')
  return apiError(event, 409, 'vacancy.not_published', 'Посилання є лише в опублікованої вакансії')
})
