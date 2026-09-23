import { requireScope } from '../../../../services/access'
import { getCase } from '../../../../services/offboarding'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** GET /offboarding/:id — карточка случая (docs/v2/33 §5.4, §10). Чужой тенант — 404 (CLAUDE.md п. 15). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'offboarding.start')
  const r = await getCase({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Звільнення не знайдено')
  return apiData(r)
})
