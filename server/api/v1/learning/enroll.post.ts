import { enrollSchema } from '../../../../shared/schemas/content'
import { requireScope } from '../../../services/access'
import { selfEnroll } from '../../../services/learning'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'learn.catalog')
  const parsed = enrollSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Вкажіть курс')
  const result = await selfEnroll({ tenantId: access.tenantId, actorId: access.userId }, parsed.data.courseId)
  if (!result.ok) {
    if (result.code === 'not_found') return apiError(event, 404, 'not_found', 'Курс не знайдено')
    if (result.code === 'exists') return apiError(event, 409, 'enrollment.exists', 'Ви вже записані на цей курс')
    return apiError(event, 403, 'catalog.hidden', 'Курс недоступний для самозапису')
  }
  return apiData(result)
})
