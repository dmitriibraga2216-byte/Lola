import { storageFilesQuerySchema } from '../../../../shared/schemas/storage'
import { requireScope } from '../../../services/access'
import { listStorageFiles } from '../../../services/storage'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * `GET /storage/trash` (docs/v2/34 §5.2): те же колонки, что у реестра, плюс «Видалено» (дата
 * и кто) и «Буде очищено» (`purgeAfter`). Сортировка — по дате удаления.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'storage.view')
  const q = storageFilesQuerySchema.safeParse({ ...(getQuery(event) as Record<string, unknown>), status: 'trash' })
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри')
  return apiData(await listStorageFiles({ tenantId: a.tenantId, actorId: a.userId }, q.data))
})
