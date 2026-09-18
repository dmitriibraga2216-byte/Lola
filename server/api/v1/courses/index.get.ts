import { requireScope } from '../../../services/access'
import { listCourses } from '../../../services/courses'
import { apiData } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'course.view')
  return apiData(await listCourses({ tenantId: access.tenantId, actorId: access.userId }))
})
