import { requireScope } from '../../../../services/access'
import { listRetentionPolicies } from '../../../../services/storagePolicies'
import { apiData } from '../../../../utils/apiResponse'

/** `GET /storage/retention-policies` (docs/v2/34 §5.2, §10): строка на каждое происхождение, у нового тенанта всё выключено. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'storage.policy')
  return apiData(await listRetentionPolicies({ tenantId: a.tenantId, actorId: a.userId }))
})
