import { z } from 'zod'
import { requireScope } from '../../../../../../../services/access'
import { openLesson } from '../../../../../../../services/learning'
import { apiData, apiError } from '../../../../../../../utils/apiResponse'

const bodySchema = z.object({ device: z.enum(['mobile', 'desktop']).optional() }).default({})

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'learn.view')
  const body = bodySchema.parse((await readBody(event).catch(() => ({}))) ?? {})
  const result = await openLesson(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'lessonId')!,
    body.device,
  )
  if (!result.ok) {
    if (result.code === 'not_found') return apiError(event, 404, 'not_found', 'Урок не знайдено')
    return apiError(event, 403, 'lesson.locked', 'Цей урок відкриється після попереднього')
  }
  return apiData(result)
})
