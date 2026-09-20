import { z } from 'zod'
import { requirePlatform } from '../../../utils/platformGuard'
import { listPlatformAudit } from '../../../services/platformTenants'
import { apiData } from '../../../utils/apiResponse'

/** GET /platform/audit?tenantId=&limit= — журнал действий оператора (docs/25 §7 п. 5). */
export default defineEventHandler(async (event) => {
  requirePlatform(event)
  const q = z.object({ tenantId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).safeParse(getQuery(event))
  return apiData(await listPlatformAudit(q.success ? q.data : {}))
})
