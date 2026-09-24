import { requireScope } from '../../../../../../services/access'
import { acceptApplication } from '../../../../../../services/publicApply'
import { apiData, apiError } from '../../../../../../utils/apiResponse'

/**
 * POST /vacancies/:id/applications/:aid/accept — принять придержанный отклик
 * (docs/v2/29 §7.7, §10).
 *
 * Решение о человеке принимает человек: ни одна проверка публичного контура не отказывает
 * кандидату сама (инвариант 18 пакета), она лишь приводит отклик сюда.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.edit')
  const r = await acceptApplication(
    { tenantId: a.tenantId, actorId: a.userId },
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'aid')!,
  )
  if (r.ok) return apiData({ state: r.state, candidateId: r.candidateId })
  switch (r.code) {
    case 'limit':
      return apiError(event, 409, 'limit.candidates_exceeded', 'Вичерпано ліміт кандидатів тарифу')
    case 'no_course':
      return apiError(event, 409, 'vacancy.no_course', 'У вакансії немає курсу відбору')
    case 'wrong_state':
      return apiError(event, 409, 'application.wrong_state', 'Відгук уже оброблено')
    default:
      return apiError(event, 404, 'not_found', 'Відгук не знайдено')
  }
})
