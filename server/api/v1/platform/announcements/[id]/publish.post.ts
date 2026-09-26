import { publishAnnouncement } from '../../../../../services/platformAnnouncements'
import { apiData } from '../../../../../utils/apiResponse'
import { requirePlatform } from '../../../../../utils/platformGuard'
import { announcementError } from '../_errors'

/** POST /platform/announcements/:id/publish (docs/04 §4.17): черновик — в ленту тенантов. */
export default defineEventHandler(async (event) => {
  const op = requirePlatform(event, 'announcements.manage')
  const r = await publishAnnouncement(op, getRouterParam(event, 'id')!)
  if (!r.ok) return announcementError(event, r.code)
  return apiData({ ok: true })
})
