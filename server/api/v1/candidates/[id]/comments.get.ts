import { requireScope } from '../../../../services/access'
import { listComments, viewerOf } from '../../../../services/candidates'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** GET /candidates/:id/comments — тред рекрутеров (docs/v2/28 §3.5, §10). Кандидату не виден. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.view')
  const rows = await listComments(viewerOf(a), getRouterParam(event, 'id')!)
  if (!rows) return apiError(event, 404, 'not_found', 'Кандидата не знайдено')
  return apiData(rows)
})
