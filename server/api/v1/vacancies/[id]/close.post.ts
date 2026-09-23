import { vacancyCloseSchema } from '../../../../../shared/schemas/vacancies'
import { requireScope } from '../../../../services/access'
import { closeVacancy, viewerOf } from '../../../../services/vacancies'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /vacancies/:id/close — закрытие (docs/v2/29 §4, §7.13, §10).
 *
 * Прохождение кандидатов **не прерывается** (критерий §13 к. 13): в ответе — список тех, кто
 * ещё в работе, рекрутер решает по каждому. Ссылка умирает вместе с токеном.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.close')
  const p = vacancyCloseSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'reason.required', 'Вкажіть причину закриття', { issues: p.error.issues })
  const r = await closeVacancy(viewerOf(a), getRouterParam(event, 'id')!, p.data)
  if (r.ok) return apiData({ ...r.vacancy, candidatesInWork: r.candidates ?? [] })
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Вакансію не знайдено')
  return apiError(event, 409, 'vacancy.wrong_state', 'Закрити можна лише опубліковану або призупинену вакансію')
})
