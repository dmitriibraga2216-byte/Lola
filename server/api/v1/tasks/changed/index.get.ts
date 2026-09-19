import { requireScope } from '../../../../services/access'
import { listChanged } from '../../../../services/tasks'
import { apiData } from '../../../../utils/apiResponse'

/** Баннер «N завдань було змінено» (docs/15 §14.6). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  return apiData(await listChanged({ tenantId: a.tenantId, actorId: a.userId }))
})
