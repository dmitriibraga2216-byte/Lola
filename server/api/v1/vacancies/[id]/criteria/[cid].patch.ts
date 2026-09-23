import { vacancyCriterionUpdateSchema } from '../../../../../../shared/schemas/vacancies'
import { requireScope } from '../../../../../services/access'
import { updateCriterion, viewerOf } from '../../../../../services/vacancies'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** PATCH /vacancies/:id/criteria/:cid — правка критерия (docs/v2/29 §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.criteria.manage')
  const p = vacancyCriterionUpdateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте критерій', { issues: p.error.issues })
  const r = await updateCriterion(viewerOf(a), getRouterParam(event, 'id')!, getRouterParam(event, 'cid')!, p.data)
  if (r === 'not_found') return apiError(event, 404, 'not_found', 'Критерій не знайдено')
  if (r === 'bad_scale') return apiError(event, 422, 'validation_failed', 'Максимум шкали має бути більшим за мінімум')
  return apiData(r)
})
