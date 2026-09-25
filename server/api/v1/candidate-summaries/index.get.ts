import { getQuery } from 'h3'
import { candidateSummaryListSchema } from '../../../../shared/schemas/candidateSummaries'
import { can, requireScope } from '../../../services/access'
import { viewerOf } from '../../../services/candidates'
import { listSummaries } from '../../../services/candidateSummaries'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * GET /candidate-summaries — Підсумки кандидатов (`docs/v2/30` §10; `summary.view`): по кандидату и
 * состоянию, ключевой курсор (`docs/04` §4.1). Роль с областью «точка» видит только своих; чужой
 * кандидат — `404`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'summary.view')
  const raw = getQuery(event)
  const q = candidateSummaryListSchema.safeParse({ candidateId: raw.candidateId, state: raw.state, cursor: raw.cursor, limit: raw.limit })
  if (!q.success) return apiError(event, 400, 'validation_failed', q.error.issues[0]?.message ?? 'Некоректні параметри', { issues: q.error.issues })
  const r = await listSummaries(viewerOf(a), q.data, can(a, 'summary.send'))
  return r ? apiData(r) : apiError(event, 404, 'not_found', 'Кандидата не знайдено')
})
