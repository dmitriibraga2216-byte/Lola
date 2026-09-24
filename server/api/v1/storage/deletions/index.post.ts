import { storageDeletionCreateSchema } from '../../../../../shared/schemas/storage'
import { requireScope } from '../../../../services/access'
import { createDeletionRequest } from '../../../../services/storageDeletion'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * `POST /storage/deletions` (docs/v2/34 §6.1, §10; решение docs/v2/44 В-17): массовое удаление —
 * только заявкой. Ответ — черновик с подсчётом: сколько файлов и байт, сколько доказательств,
 * сколько будет пропущено. Удаление происходит на подтверждении.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'storage.delete')
  const p = storageDeletionCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Оберіть файли для видалення')
  const r = await createDeletionRequest({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r.ok) {
    if (r.code === 'too_many') return apiError(event, 422, 'deletion.too_many', 'Забагато файлів для однієї заявки (понад 5000). Звузьте фільтр або налаштуйте політику зберігання')
    return apiError(event, 422, 'deletion.empty', 'За цією вибіркою файлів немає')
  }
  return apiData(r.request)
})
