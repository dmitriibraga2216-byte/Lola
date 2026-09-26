import { listForOperator } from '../../../../services/platformAnnouncements'
import { apiData } from '../../../../utils/apiResponse'
import { requirePlatform } from '../../../../utils/platformGuard'

/** GET /platform/announcements (docs/04 §4.17, docs/24 §4.7): объявления платформы для панели оператора. */
export default defineEventHandler(async (event) => {
  requirePlatform(event, 'platform.read')
  return apiData(await listForOperator())
})
