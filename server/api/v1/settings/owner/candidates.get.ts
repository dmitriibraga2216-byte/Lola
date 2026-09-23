import { requireScope } from '../../../../services/access'
import { transferCandidates } from '../../../../services/owner'
import { apiData } from '../../../../utils/apiResponse'

/** GET /settings/owner/candidates?q= — кому можна передати володіння (діючі співробітники, крім себе). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'tenant.transfer')
  const q = String((getQuery(event).q ?? '')).slice(0, 100)
  return apiData(await transferCandidates({ tenantId: a.tenantId, actorId: a.userId }, q))
})
