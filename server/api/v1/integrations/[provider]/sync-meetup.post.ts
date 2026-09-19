import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { createZoomMeeting, fetchZoomAttendance, syncMeetupToCalendar } from '../../../../services/googleApps'
import { recordParticipation } from '../../../../services/meetups'
import { providerParam } from './status.get'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** Ручной запуск: событие в календаре / Zoom-встреча / участие из Zoom-отчёта для занятия. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.manage')
  const p = providerParam(event)
  const b = z.object({ meetupId: z.string().uuid(), action: z.enum(['calendar', 'meeting', 'attendance']) }).safeParse(await readBody(event))
  if (!p || !b.success) return apiError(event, 400, 'validation_failed', 'Вкажіть заняття і дію')
  if (b.data.action === 'calendar' && p === 'google') { const r = await syncMeetupToCalendar(a.tenantId, b.data.meetupId); return r.ok ? apiData(r) : apiError(event, 502, 'provider_error', `Google Calendar: ${r.error}`) }
  if (b.data.action === 'meeting' && p === 'zoom') { const r = await createZoomMeeting(a.tenantId, b.data.meetupId); return r.ok ? apiData(r) : apiError(event, 502, 'provider_error', `Zoom: ${r.error}`) }
  if (b.data.action === 'attendance' && p === 'zoom') {
    const rows = await fetchZoomAttendance(a.tenantId, b.data.meetupId)
    if (!rows) return apiError(event, 502, 'provider_error', 'Zoom: звіт недоступний')
    return apiData(await recordParticipation({ tenantId: a.tenantId, actorId: a.userId }, b.data.meetupId, rows, 'provider'))
  }
  return apiError(event, 400, 'validation_failed', 'Ця дія недоступна для провайдера')
})
