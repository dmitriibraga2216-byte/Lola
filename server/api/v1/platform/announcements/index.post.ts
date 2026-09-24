import { announcementCreateSchema } from '../../../../../shared/schemas/platformAnnouncements'
import { createAnnouncement } from '../../../../services/platformAnnouncements'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { requirePlatform } from '../../../../utils/platformGuard'
import { announcementError } from './_errors'

/**
 * POST /platform/announcements (docs/04 §4.17, docs/v2/39 П-24.2): объявление платформы —
 * черновик или сразу в ленту тенантов (`publish`). Адресация: всем, по тарифу, конкретным
 * пространствам. Это не новость тенанта: тенант его только читает.
 */
export default defineEventHandler(async (event) => {
  const op = requirePlatform(event)
  const p = announcementCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте заголовок, текст і адресацію', { issues: p.error.issues })
  const r = await createAnnouncement(op, p.data)
  if (!r.ok) return announcementError(event, r.code)
  return apiData({ id: r.id })
})
