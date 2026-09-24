import { requireScope } from '../../../services/access'
import { listPendingUploads } from '../../../services/storagePending'
import { apiData } from '../../../utils/apiResponse'

/** `GET /storage/pending-uploads` (docs/v2/34 §7.5, §10): записи сотрудников, ждущие места в хранилище. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'storage.view')
  return apiData(await listPendingUploads({ tenantId: a.tenantId, actorId: a.userId }))
})
