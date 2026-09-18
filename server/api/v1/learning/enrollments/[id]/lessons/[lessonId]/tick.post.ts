import { tickSchema } from '../../../../../../../../shared/schemas/content'
import { requireScope } from '../../../../../../../services/access'
import { tickLesson } from '../../../../../../../services/learning'
import { apiData, apiError } from '../../../../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'learn.view')
  const parsed = tickSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Невірний тік')
  const result = await tickLesson(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'lessonId')!,
    parsed.data,
  )
  if (!result) return apiError(event, 404, 'not_found', 'Урок не відкрито')
  return apiData(result)
})
