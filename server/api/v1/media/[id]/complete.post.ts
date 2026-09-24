import { can, requireAccess } from '../../../../services/access'
import { completeUpload, getMedia, LEARNER_UPLOAD_ORIGINS, SELF_SERVICE_ORIGINS } from '../../../../services/media'
import { enqueueMediaProcess } from '../../../../services/queue'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * Подтверждение загрузки (docs/04 §4.15). `media.upload` — любой файл; без него загрузивший
 * подтверждает только **свой** файл: самообслуживания (`SELF_SERVICE_ORIGINS`, docs/v2/38 §2)
 * или собственной работы при `learn.attempt` (`LEARNER_UPLOAD_ORIGINS`, docs/v2/34 §7.5).
 * Файл отложенной записи закрывает строку ожидания и отдаёт сдачу наставнику (§13 к. 1).
 */
export default defineEventHandler(async (event) => {
  const access = await requireAccess(event)
  const ctx = { tenantId: access.tenantId, actorId: access.userId }
  const id = getRouterParam(event, 'id')!
  const uploader = can(access, 'media.upload')
  if (!uploader) {
    const own = await getMedia(ctx, id).catch(() => null)
    const origin = own?.origin as never
    const allowed = own && own.ownerUserId === access.userId
      && (SELF_SERVICE_ORIGINS.includes(origin) || (LEARNER_UPLOAD_ORIGINS.includes(origin) && can(access, 'learn.attempt')))
    if (!allowed) return apiError(event, 403, 'forbidden', 'Немає доступу')
  }
  const media = await completeUpload(ctx, id, { ownOnly: !uploader })
  if (!media) return apiError(event, 404, 'not_found', 'Файл не знайдено')
  await enqueueMediaProcess(access.tenantId, media.id)
  return apiData({ id: media.id, status: media.status })
})
