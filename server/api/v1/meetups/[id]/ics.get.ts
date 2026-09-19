import { requireScope } from '../../../../services/access'
import { getMeetup, toIcs } from '../../../../services/meetups'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.view')
  const m = await getMeetup({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!m) throw createError({ statusCode: 404 })
  setHeader(event, 'content-type', 'text/calendar; charset=utf-8')
  setHeader(event, 'content-disposition', `attachment; filename="meetup-${m.id.slice(0, 8)}.ics"`)
  return toIcs(m)
})
