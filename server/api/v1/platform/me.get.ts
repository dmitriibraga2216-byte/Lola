import { requirePlatform } from '../../../utils/platformGuard'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(event => apiData(requirePlatform(event)))
