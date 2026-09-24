import { announcementPatchSchema } from '../../../../../../shared/schemas/platformAnnouncements'
import { updateAnnouncement } from '../../../../../services/platformAnnouncements'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { requirePlatform } from '../../../../../utils/platformGuard'
import { announcementError } from '../_errors'

/** PATCH /platform/announcements/:id (docs/04 §4.17): правка текста и адресации; снятое со стрічки не правится. */
export default defineEventHandler(async (event) => {
  const op = requirePlatform(event)
  const p = announcementPatchSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля', { issues: p.error.issues })
  const r = await updateAnnouncement(op, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) return announcementError(event, r.code)
  return apiData({ ok: true })
})
