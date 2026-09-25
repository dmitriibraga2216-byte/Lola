import { candidateSummaryCreateSchema } from '../../../../shared/schemas/candidateSummaries'
import { requireScope } from '../../../services/access'
import { viewerOf } from '../../../services/candidates'
import { buildSummary } from '../../../services/candidateSummaries'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * POST /candidate-summaries — «Сформувати» / «Сформувати заново» (`docs/v2/30` §5.4, §7.14, §10;
 * `summary.edit`): новая версия документа. Прежняя отправленная версия по ссылке больше не
 * открывается (§4). Собирать не из чего — `409 summary.no_data`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'summary.edit')
  const p = candidateSummaryCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте запит', { issues: p.error.issues })
  const r = await buildSummary(viewerOf(a), p.data.candidateId, p.data.sections)
  if (r.ok) return apiData(r.summary)
  if (r.code === 'no_data') return apiError(event, 409, 'summary.no_data', 'Недостатньо даних для підсумку: у кандидата немає ні проходження, ні оцінок, ні співбесіди')
  return apiError(event, 404, 'not_found', 'Кандидата не знайдено')
})
