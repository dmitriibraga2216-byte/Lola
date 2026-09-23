import { requireScope } from '../../../../services/access'
import { archiveVacancy, viewerOf } from '../../../../services/vacancies'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /vacancies/:id/archive — в архив (docs/v2/29 §4, §10).
 * Кандидаты в работе держат вакансию в реестре: убрать её из глаз, пока по людям не принято
 * решение, — значит потерять этих людей.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.close')
  const r = await archiveVacancy(viewerOf(a), getRouterParam(event, 'id')!)
  if (r.ok) return apiData(r.vacancy)
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Вакансію не знайдено')
  if (r.code === 'has_candidates') return apiError(event, 409, 'vacancy.has_pending_applications', 'Кандидати ще проходять відбір', { count: r.count })
  return apiError(event, 409, 'vacancy.wrong_state', 'До архіву йде чернетка або закрита вакансія')
})
