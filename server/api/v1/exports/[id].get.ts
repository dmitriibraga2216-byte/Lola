import { requireScope } from '../../../services/access'
import { getExport } from '../../../services/reportExports'
import { apiData, apiError } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.team')
  const e = await getExport({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!e) return apiError(event, 404, 'not_found', 'Вивантаження не знайдено')
  return apiData(e)
})
