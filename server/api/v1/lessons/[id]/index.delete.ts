import { requireScope } from '../../../../services/access'
import { deleteLesson } from '../../../../services/courses'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'course.edit')
  const lesson = await deleteLesson(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
  )
  if (!lesson) return apiError(event, 404, 'not_found', 'Урок не знайдено')
  return apiData({ ok: true })
})
