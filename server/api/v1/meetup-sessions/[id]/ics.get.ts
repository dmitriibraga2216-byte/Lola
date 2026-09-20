import { requireScope } from '../../../../services/access'
import { getSession, toIcs } from '../../../../services/meetupSessions'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.view')
  const s = await getSession({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!s) throw createError({ statusCode: 404 })
  setHeader(event, 'content-type', 'text/calendar; charset=utf-8')
  setHeader(event, 'content-disposition', `attachment; filename="session-${s.id.slice(0, 8)}.ics"`)
  return toIcs({ id: s.id, title: s.meetup.title, startsAt: s.startsAt, endsAt: s.endsAt, room: s.room, address: s.address, location: s.location })
})
