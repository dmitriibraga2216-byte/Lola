import { requireScope } from '../../../../../services/access'
import { enrollmentTree } from '../../../../../services/learning'
import { apiData, apiError } from '../../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'learn.view')
  const tree = await enrollmentTree(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
  )
  if (!tree) return apiError(event, 404, 'not_found', 'Запис не знайдено')
  return apiData(tree)
})
