import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { listNotices } from '../../../services/notices'
import { apiData } from '../../../utils/apiResponse'

/** GET /notices — список объявлений админки с охватом «Ознайомились N із M» (docs/21 §14.5). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const q = z.object({ status: z.enum(['draft', 'published', 'archived']).optional() }).parse(getQuery(event))
  return apiData(await listNotices({ tenantId: a.tenantId, actorId: a.userId }, q))
})
