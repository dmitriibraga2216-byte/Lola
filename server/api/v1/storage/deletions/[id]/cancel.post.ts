import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { cancelDeletionRequest } from '../../../../../services/storageDeletion'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** `POST /storage/deletions/:id/cancel` (docs/v2/34 §4, §10): отмена — только до подтверждения. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'storage.delete')
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) return apiError(event, 404, 'not_found', 'Заявку не знайдено')
  const r = await cancelDeletionRequest({ tenantId: a.tenantId, actorId: a.userId }, id.data)
  if (!r.ok) {
    if (r.code === 'not_draft') return apiError(event, 409, 'deletion.not_draft', 'Заявку вже виконано або скасовано')
    return apiError(event, 404, 'not_found', 'Заявку не знайдено')
  }
  return apiData({ status: 'cancelled' })
})
