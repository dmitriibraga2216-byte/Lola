import { requireScope } from '../../../../services/access'
import { completeUpload } from '../../../../services/media'
import { enqueueMediaProcess } from '../../../../services/queue'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'media.upload')
  const media = await completeUpload(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
  )
  if (!media) return apiError(event, 404, 'not_found', 'Файл не знайдено')
  await enqueueMediaProcess(access.tenantId, media.id)
  return apiData({ id: media.id, status: media.status })
})
