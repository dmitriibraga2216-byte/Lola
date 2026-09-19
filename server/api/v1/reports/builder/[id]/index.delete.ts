import { requireScope } from '../../../../../services/access'
import { deleteSaved } from '../../../../../services/reportBuilder'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.builder')
  if (!await deleteSaved({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)) return apiError(event, 404, 'not_found', 'Звіт не знайдено')
  return apiData({ ok: true })
})
