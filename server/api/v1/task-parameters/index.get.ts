import { requireScope } from '../../../services/access'
import { listTaskParameters } from '../../../services/tasks'
import { apiData } from '../../../utils/apiResponse'

/** «Додаткові параметри для завдань» (docs/15 §14.5). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  return apiData(await listTaskParameters({ tenantId: a.tenantId, actorId: a.userId }))
})
