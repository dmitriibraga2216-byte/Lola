import { requireScope } from '../../../../services/access'
import { tenantSettings } from '../../../../services/settings'
import { apiData } from '../../../../utils/apiResponse'
/** GET /settings/notification-schedule (docs/23 §13.2.1, docs/04 §4.16): час відправлення по класах подій. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const s = await tenantSettings({ tenantId: a.tenantId, actorId: a.userId })
  return apiData({ quietHours: s.quietHours, schedule: s.notificationSchedule, birthdayReminderDays: s.birthdays.reminderDays })
})
