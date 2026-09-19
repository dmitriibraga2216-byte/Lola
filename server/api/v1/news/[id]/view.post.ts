import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { trackView } from '../../../../services/news'
import { apiData } from '../../../../utils/apiResponse'
/** Прогресс чтения (docs/21 §3.2 seconds_spent): секунды и прокрутка до конца. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = z.object({ seconds: z.number().int().min(0).max(600).optional(), scrolledToEnd: z.boolean().optional() }).safeParse(await readBody(event) ?? {})
  return apiData(await trackView({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.success ? p.data : {}))
})
