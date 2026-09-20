import { requireScope } from '../../../services/access'
import { listResourceCategories } from '../../../services/resources'
import { apiData } from '../../../utils/apiResponse'

/** Категории ресурсов с числом ресурсов и порядком (мокап ContentCategories). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.view')
  return apiData(await listResourceCategories({ tenantId: a.tenantId, actorId: a.userId }))
})
