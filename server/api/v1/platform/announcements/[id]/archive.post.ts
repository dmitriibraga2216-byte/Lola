import { archiveAnnouncement } from '../../../../../services/platformAnnouncements'
import { apiData } from '../../../../../utils/apiResponse'
import { requirePlatform } from '../../../../../utils/platformGuard'
import { announcementError } from '../_errors'

/** POST /platform/announcements/:id/archive (docs/04 §4.17): снять со стрічки; история и счёт прочтений остаются. */
export default defineEventHandler(async (event) => {
  const op = requirePlatform(event, 'announcements.manage')
  const r = await archiveAnnouncement(op, getRouterParam(event, 'id')!)
  if (!r.ok) return announcementError(event, r.code)
  return apiData({ ok: true })
})
