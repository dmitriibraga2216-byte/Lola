import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { register } from '../../../../services/meetups'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.enroll')
  const p = z.object({ guestsCount: z.number().int().min(0).max(10).optional() }).safeParse(await readBody(event).catch(() => ({})) ?? {})
  const r = await register({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, a.userId, { guestsCount: p.success ? p.data.guestsCount : 0 })
  if (!r.ok) {
    const msg: Record<string, string> = { not_found: 'Заняття не знайдено', closed: 'Запис закрито', full: 'Місць немає', already: 'Ви вже записані', has_sessions: 'Це заняття записується через сесії — оберіть сесію в розкладі' }
    return apiError(event, r.code === 'not_found' ? 404 : 409, `meetup.${r.code}`, msg[r.code]!)
  }
  return apiData(r)
})
