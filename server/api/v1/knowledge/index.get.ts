import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { listArticles } from '../../../services/knowledge'
import { apiData } from '../../../utils/apiResponse'
const q = z.object({ status: z.string().optional(), categoryId: z.string().uuid().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  return apiData(await listArticles({ tenantId: a.tenantId, actorId: a.userId }, q.parse(getQuery(event))))
})
