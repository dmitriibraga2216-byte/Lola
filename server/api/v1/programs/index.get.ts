import { z } from 'zod'
import { requireScope, can } from '../../../services/access'
import { listPrograms } from '../../../services/programs'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const q = z.object({ all: z.coerce.boolean().optional() }).parse(getQuery(event))
  return apiData(await listPrograms({ tenantId: a.tenantId, actorId: a.userId }, { all: !!q.all && can(a, 'program.manage') }))
})
