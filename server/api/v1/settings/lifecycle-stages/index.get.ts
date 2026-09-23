import { requireScope } from '../../../../services/access'
import { listStages } from '../../../../services/lifecycle'
import { apiData } from '../../../../utils/apiResponse'

/** GET /settings/lifecycle-stages — справочник этапов с возможностями (docs/v2/33 §5.2, §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'lifecycle.view')
  return apiData(await listStages({ tenantId: a.tenantId, actorId: a.userId }))
})
