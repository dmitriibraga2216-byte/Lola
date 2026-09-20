import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { registerSession } from '../../../../services/meetupSessions'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.enroll')
  const p = z.object({ guestsCount: z.number().int().min(0).max(10).optional(), enrollmentId: z.string().uuid().optional(), lessonId: z.string().uuid().optional() }).safeParse(await readBody(event).catch(() => ({})) ?? {})
  const opts = p.success ? p.data : {}
  const r = await registerSession({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, a.userId, opts)
  if (!r.ok) {
    const msg: Record<string, string> = { not_found: 'Сесію не знайдено', closed: 'Запис закрито', full: 'Місць немає', already: 'Ви вже записані', announcement_only: 'Це анонс без запису' }
    return apiError(event, r.code === 'not_found' ? 404 : 409, `meetup.${r.code}`, msg[r.code]!)
  }
  return apiData(r)
})
