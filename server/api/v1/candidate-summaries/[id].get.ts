import { can, requireScope } from '../../../services/access'
import { viewerOf } from '../../../services/candidates'
import { getSummary } from '../../../services/candidateSummaries'
import { apiData, apiError } from '../../../utils/apiResponse'

/** GET /candidate-summaries/:id — документ с версией, состоянием и планом авто-отправки (`docs/v2/30` §5.4; `summary.view`). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'summary.view')
  const r = await getSummary(viewerOf(a), getRouterParam(event, 'id')!, can(a, 'summary.send'))
  return r ? apiData(r) : apiError(event, 404, 'not_found', 'Підсумок не знайдено')
})
