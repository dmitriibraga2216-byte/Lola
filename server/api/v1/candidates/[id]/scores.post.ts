import { candidateScoreSchema } from '../../../../../shared/schemas/candidates'
import { requireAnyScope } from '../../../../services/access'
import { addScore, viewerOf } from '../../../../services/candidates'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /candidates/:id/scores — ручная оценка (docs/v2/28 §3.4, §10).
 *
 * Ставит её человек: рекрутер по своим кандидатам, наставник по своей проверке (§2).
 * Вид `ai` через эту ручку не проходит — его пишет авто-собеседование (`docs/v2/30`):
 * ИИ не принимает решений о людях, и отличить оценку модели от оценки человека в отчёте
 * можно только если их не смешивать на входе.
 */
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, ['candidate.edit', 'review.grade'])
  const p = candidateScoreSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте оцінку', { issues: p.error.issues })
  const r = await addScore(viewerOf(a), getRouterParam(event, 'id')!, p.data)
  if (r.ok) return apiData(r.score)
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Кандидата не знайдено')
  return apiError(event, 422, 'validation_failed', 'Рівень шкали не знайдено')
})
