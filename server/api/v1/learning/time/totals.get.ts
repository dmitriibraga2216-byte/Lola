import { requireScope } from '../../../../services/access'
import { timeTotals } from '../../../../services/learningTime'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { timeTotalsQuerySchema } from '../../../../../shared/schemas/learningTime'

/**
 * GET /learning/time/totals — «Час на контент» и «Час на випробування» по элементам
 * (docs/v2/37 §2, §10). Своё время видит каждый; чужое — `time.metrics.view` в своей области
 * (иначе `403 forbidden`); человек другого тенанта или несуществующий — `404` (CLAUDE.md п. 15).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = timeTotalsQuerySchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте параметри')
  const r = await timeTotals(a, p.data)
  if (r.ok) return apiData(r.rows)
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Людину не знайдено')
  return apiError(event, 403, 'forbidden', 'Немає доступу')
})
