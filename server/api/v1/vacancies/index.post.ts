import { vacancyCreateSchema } from '../../../../shared/schemas/vacancies'
import { requireScope } from '../../../services/access'
import { createVacancy } from '../../../services/vacancies'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * POST /vacancies — создание (docs/v2/29 §6.1, §10).
 *
 * Вакансия всегда рождается черновиком: публикация — явное действие со своими проверками
 * (§4, Г-29.2), а не побочный эффект сохранения. Токен и `public_enabled` в тело не входят.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.edit')
  const p = vacancyCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте дані вакансії', { issues: p.error.issues })
  return apiData(await createVacancy({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
