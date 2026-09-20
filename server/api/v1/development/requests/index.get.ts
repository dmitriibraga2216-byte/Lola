import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { requestsTable } from '../../../../services/requests'
import { apiData } from '../../../../utils/apiResponse'

/** Повна таблиця заявок з фільтрами (docs/33 D-033, мокап ExternalRequests) — на відміну від `pending`, усі стани. */
const q = z.object({ kind: z.enum(['external', 'career']).optional(), status: z.string().max(40).optional(), from: z.string().date().optional(), to: z.string().date().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'request.decide')
  const p = q.parse(getQuery(event))
  return apiData(await requestsTable({ tenantId: a.tenantId, actorId: a.userId }, p))
})
