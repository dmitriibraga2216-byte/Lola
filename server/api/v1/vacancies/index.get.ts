import { vacancyListSchema } from '../../../../shared/schemas/vacancies'
import { requireScope } from '../../../services/access'
import { listVacancies, viewerOf } from '../../../services/vacancies'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * GET /vacancies — реестр вакансий (docs/v2/29 §5.1, §10).
 *
 * Область видимости считает сервер (§2): сеть — всё, точка — свои точки плюс те вакансии,
 * где смотрящий назначен рекрутером. Чужая вакансия не существует, а не «запрещена».
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.view')
  const p = vacancyListSchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте фільтри', { issues: p.error.issues })
  const items = await listVacancies(viewerOf(a), p.data)
  return apiData({ items, meta: { total: items.length } })
})
