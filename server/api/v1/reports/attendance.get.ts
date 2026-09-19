import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { attendanceReport } from '../../../services/meetups'
import { complexReport } from '../../../services/complexTests'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.team')
  const q = z.object({ from: z.string().date().optional(), to: z.string().date().optional() }).parse(getQuery(event))
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  return apiData({ ...(await attendanceReport(ctx, q)), complex: await complexReport(ctx) })
})
