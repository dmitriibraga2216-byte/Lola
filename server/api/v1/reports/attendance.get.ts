import { z } from 'zod'
import { reportScope, requireScope } from '../../../services/access'
import { attendanceReport } from '../../../services/meetups'
import { attendanceReport as sessionAttendanceReport } from '../../../services/meetupSessions'
import { complexReport } from '../../../services/complexTests'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.team')
  const q = z.object({ from: z.string().date().optional(), to: z.string().date().optional() }).parse(getQuery(event))
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  // Події (kind=event) — старий звіт по meetups; заняття/вебінари з сесіями — новий, по призначенню (docs/18 Г-18.2)
  return apiData({ ...(await attendanceReport(ctx, { ...q, scope: await reportScope(a) })), ...(await sessionAttendanceReport(ctx, q)), complex: await complexReport(ctx) })
})
