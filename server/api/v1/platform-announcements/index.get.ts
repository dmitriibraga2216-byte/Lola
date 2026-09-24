import { requireScope } from '../../../services/access'
import { tenantFeed } from '../../../services/platformAnnouncements'
import { apiData } from '../../../utils/apiResponse'

/**
 * GET /platform-announcements (docs/04 §4.13, docs/v2/39 П-21): лента объявлений платформы —
 * только чтение, отдельно от новостей компании (`/news`). Путь — не под `/platform/*`: тот
 * контур принадлежит оператору (cookie `lola_ops`), а это ручка сессии тенанта.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData(await tenantFeed({ tenantId: a.tenantId, actorId: a.userId }))
})
