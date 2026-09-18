import { requireScope } from '../../../../services/access'
import { getCourseEditor } from '../../../../services/courses'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'course.view')
  const editor = await getCourseEditor(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
  )
  if (!editor) return apiError(event, 404, 'not_found', 'Курс не знайдено')
  return apiData(editor)
})
