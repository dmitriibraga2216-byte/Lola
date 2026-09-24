import { can, requireAccess } from '../../../../services/access'
import { completeUpload, getMedia, SELF_SERVICE_ORIGINS } from '../../../../services/media'
import { enqueueMediaProcess } from '../../../../services/queue'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * Подтверждение загрузки. `media.upload` — или свой файл самообслуживания (`SELF_SERVICE_ORIGINS`,
 * docs/v2/38 §2): загрузивший без `media.upload` подтверждает только то, что загрузил сам.
 */
export default defineEventHandler(async (event) => {
  const access = await requireAccess(event)
  const ctx = { tenantId: access.tenantId, actorId: access.userId }
  const id = getRouterParam(event, 'id')!
  if (!can(access, 'media.upload')) {
    const own = await getMedia(ctx, id).catch(() => null)
    if (!own || own.ownerUserId !== access.userId || !SELF_SERVICE_ORIGINS.includes(own.origin as never)) {
      return apiError(event, 403, 'forbidden', 'Немає доступу')
    }
  }
  const media = await completeUpload(ctx, id)
  if (!media) return apiError(event, 404, 'not_found', 'Файл не знайдено')
  await enqueueMediaProcess(access.tenantId, media.id)
  return apiData({ id: media.id, status: media.status })
})
