import { vacancyUpdateSchema } from '../../../../../shared/schemas/vacancies'
import { requireScope } from '../../../../services/access'
import { updateVacancy, viewerOf } from '../../../../services/vacancies'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * PATCH /vacancies/:id — правка (docs/v2/29 §7.12, §10).
 *
 * **Созданные назначения не трогает.** В ответе есть `candidatesInProgress`, чтобы форма
 * написала «Зміни вплинуть лише на нові відгуки. Кандидатів у роботі: N» (критерий §13 к. 8).
 * `409 conflict` — оптимистическая блокировка по `updatedAt`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.edit')
  const p = vacancyUpdateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте дані вакансії', { issues: p.error.issues })
  const r = await updateVacancy(viewerOf(a), getRouterParam(event, 'id')!, p.data)
  if (r.ok) return apiData(r.vacancy)
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Вакансію не знайдено')
  if (r.code === 'conflict') return apiError(event, 409, 'conflict', 'Вакансію змінив інший користувач', { vacancy: r.vacancy })
  return apiError(event, 409, 'vacancy.archived', 'Архівну вакансію не редагують: спочатку відновіть її')
})
