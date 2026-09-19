import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { search } from '../../../services/knowledge'
import { apiData } from '../../../utils/apiResponse'
const q = z.object({ q: z.string().max(200).default(''), limit: z.coerce.number().int().min(1).max(50).default(20) })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = q.parse(getQuery(event))
  return apiData(await search({ tenantId: a.tenantId, actorId: a.userId }, p.q, p.limit))
})
