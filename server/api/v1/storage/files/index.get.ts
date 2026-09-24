import { storageFilesQuerySchema } from '../../../../../shared/schemas/storage'
import { requireScope } from '../../../../services/access'
import { listStorageFiles } from '../../../../services/storage'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * `GET /storage/files` (docs/v2/34 §5.1, §10): реестр с фильтрами, курсор по 50 (лимит 100).
 * Чужой тенант не виден под RLS — список просто не содержит его файлов.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'storage.view')
  const q = storageFilesQuerySchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри')
  return apiData(await listStorageFiles({ tenantId: a.tenantId, actorId: a.userId }, q.data))
})
