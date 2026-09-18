import { uploadUrlSchema } from '../../../../shared/schemas/content'
import { requireScope } from '../../../services/access'
import { createUploadUrl } from '../../../services/media'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'media.upload')
  const parsed = uploadUrlSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Перевірте файл')
  const result = await createUploadUrl({ tenantId: access.tenantId, actorId: access.userId }, parsed.data)
  if (!result.ok) return apiError(event, 400, `media.${result.code}`, result.message)
  return apiData(result)
})
