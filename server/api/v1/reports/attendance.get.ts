import { z } from 'zod'
import { reportScope, requireScope } from '../../../services/access'
import { attendanceReport } from '../../../services/meetups'
import { attendanceReport as sessionAttendanceReport } from '../../../services/meetupSessions'
import { complexReport } from '../../../services/complexTests'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.team')
  const q = z.object({ from: z.string().date().optional(), to: z.string().date().optional(), meetupId: z.string().uuid().optional(), sessionId: z.string().uuid().optional() }).parse(getQuery(event))
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const scope = await reportScope(a)
  // Події (kind=event) — старий звіт по meetups; заняття/вебінари з сесіями — на каркасі звітів (docs/18 Г-18.2, docs/33 D-030)
  return apiData({ ...(await attendanceReport(ctx, { from: q.from, to: q.to, scope })), ...(await sessionAttendanceReport(ctx, { ...q, scope })), complex: await complexReport(ctx) })
})
