import { CANDIDATE_SCORE_KINDS } from '../../../../../shared/enums'
import type { CandidateScoreKind } from '../../../../../shared/enums'
import { requireAnyScope } from '../../../../services/access'
import { listScores, viewerOf } from '../../../../services/candidates'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** GET /candidates/:id/scores — оценки; `history=true` отдаёт и снятые (docs/v2/28 §3.4, §10). */
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, ['candidate.view', 'review.queue'])
  const q = getQuery(event)
  const kind = typeof q.kind === 'string' && (CANDIDATE_SCORE_KINDS as readonly string[]).includes(q.kind)
    ? q.kind as CandidateScoreKind
    : undefined
  const rows = await listScores(viewerOf(a), getRouterParam(event, 'id')!, { kind, history: q.history === 'true' })
  if (!rows) return apiError(event, 404, 'not_found', 'Кандидата не знайдено')
  return apiData(rows)
})
