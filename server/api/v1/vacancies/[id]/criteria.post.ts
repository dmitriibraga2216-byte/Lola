import { vacancyCriterionSchema } from '../../../../../shared/schemas/vacancies'
import { requireScope } from '../../../../services/access'
import { addCriterion, viewerOf } from '../../../../services/vacancies'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /vacancies/:id/criteria — новый критерий (docs/v2/29 §3.3, Г-29.5, §10).
 * Шкала задаётся явно: без неё веса несравнимы между критериями, а свёртка перестаёт быть
 * воспроизводимой.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.criteria.manage')
  const p = vacancyCriterionSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте критерій', { issues: p.error.issues })
  const r = await addCriterion(viewerOf(a), getRouterParam(event, 'id')!, p.data)
  if (r === 'not_found') return apiError(event, 404, 'not_found', 'Вакансію не знайдено')
  return apiData(r)
})
