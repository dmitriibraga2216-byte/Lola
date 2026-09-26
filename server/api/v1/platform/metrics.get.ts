import { requirePlatform } from '../../../utils/platformGuard'
import { platformMetrics } from '../../../services/platform'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => { requirePlatform(event, 'platform.read'); return apiData(await platformMetrics()) })
