import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { listChiefs } from '../../../services/people'
import { apiData } from '../../../utils/apiResponse'

/** Матриця функціональних керівників (docs/16 §3.5). */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.view')
  const q = z.object({ userId: z.string().uuid().optional() }).safeParse(getQuery(event))
  return apiData(await listChiefs({ tenantId: access.tenantId, actorId: access.userId }, q.success ? q.data.userId : undefined))
})
