import { requireScope } from '../../../../services/access'
import { pauseVacancy, viewerOf } from '../../../../services/vacancies'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /vacancies/:id/pause — приостановка (docs/v2/29 §4, §10).
 * Объявления на площадках не снимаются: снятие и повторная постановка стоят денег и теряют
 * позицию в выдаче. Публичная страница отдаёт 410 с подпиской — это уже публичный контур.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.edit')
  const r = await pauseVacancy(viewerOf(a), getRouterParam(event, 'id')!)
  if (r.ok) return apiData(r.vacancy)
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Вакансію не знайдено')
  return apiError(event, 409, 'vacancy.not_published', 'Призупинити можна лише опубліковану вакансію')
})
