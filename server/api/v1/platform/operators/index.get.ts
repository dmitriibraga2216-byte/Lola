import { listOperators } from '../../../../services/platformOperators'
import { apiData } from '../../../../utils/apiResponse'
import { requirePlatform } from '../../../../utils/platformGuard'

/** GET /platform/operators — операторы платформы, их роли и состояние (docs/25 §7 п. 7). */
export default defineEventHandler(async (event) => {
  requirePlatform(event, 'operators.read')
  return apiData(await listOperators())
})
