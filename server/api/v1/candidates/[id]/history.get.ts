import { requireScope } from '../../../../services/access'
import { listHistory, viewerOf } from '../../../../services/candidates'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** GET /candidates/:id/history — лента смен колонки (docs/v2/28 §3.6, §5.3 вкладка «Історія»). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.view')
  const rows = await listHistory(viewerOf(a), getRouterParam(event, 'id')!)
  if (!rows) return apiError(event, 404, 'not_found', 'Кандидата не знайдено')
  return apiData(rows)
})
