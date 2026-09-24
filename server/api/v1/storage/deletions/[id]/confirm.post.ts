import { z } from 'zod'
import { storageDeletionConfirmSchema } from '../../../../../../shared/schemas/storage'
import { requireScope } from '../../../../../services/access'
import { confirmDeletionRequest } from '../../../../../services/storageDeletion'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/**
 * `POST /storage/deletions/:id/confirm` (docs/v2/34 §6.1, §10): подтверждение и исполнение
 * заявки. При доказательствах в выборке — причина (10–500) и слово «ВИДАЛИТИ»; без них
 * `422 reason_required` / `422 confirm_phrase_mismatch`, и ни один файл не удаляется.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'storage.delete')
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) return apiError(event, 404, 'not_found', 'Заявку не знайдено')
  const p = storageDeletionConfirmSchema.safeParse(await readBody(event).catch(() => ({})) ?? {})
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Підтвердьте, що ознайомились')
  const r = await confirmDeletionRequest({ tenantId: a.tenantId, actorId: a.userId }, id.data, p.data)
  if (!r.ok) {
    if (r.code === 'reason_required') return apiError(event, 422, 'reason_required', 'Вкажіть причину: від 10 до 500 символів')
    if (r.code === 'confirm_phrase_mismatch') return apiError(event, 422, 'confirm_phrase_mismatch', 'Введіть слово ВИДАЛИТИ великими літерами')
    if (r.code === 'not_draft') return apiError(event, 409, 'deletion.not_draft', 'Заявку вже виконано або скасовано')
    return apiError(event, 404, 'not_found', 'Заявку не знайдено')
  }
  return apiData(r.request)
})
