import { vacancyCriterionScoresSchema } from '../../../../../shared/schemas/vacancies'
import { requireScope } from '../../../../services/access'
import { saveCriterionScores, viewerOf } from '../../../../services/vacancies'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /candidates/:id/criterion-scores — баллы по критериям вакансии (docs/v2/29 §3.3, §10).
 *
 * Ответ — **одна** свёрнутая `candidate_scores` с `kind='recruiter'`; предыдущая строка того
 * же вида теряет `is_current` (критерий §13 к. 11). `criticalLow` — предупреждение о
 * критическом критерии с минимальным баллом: предупреждение, а не запрет найма (инвариант 18).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.criteria.manage')
  const p = vacancyCriterionScoresSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте оцінки', { issues: p.error.issues })
  const r = await saveCriterionScores(viewerOf(a), getRouterParam(event, 'id')!, p.data)
  if (r.ok) return apiData({ score: r.score, criticalLow: r.criticalLow, counted: r.counted })
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Кандидата або критерій не знайдено')
  return apiError(event, 422, 'criterion.out_of_scale', 'Бал виходить за межі шкали критерію', { criterionId: r.criterionId })
})
