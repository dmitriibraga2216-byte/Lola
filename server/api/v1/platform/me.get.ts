import { requirePlatform } from '../../../utils/platformGuard'
import { hostConfig } from '../../../services/tenantResolve'
import { apiData } from '../../../utils/apiResponse'

/** GET /platform/me — оператор и базовый домен тенантов (`<slug>.<base>`, docs/25 §16.1) для колонки «Тенант». */
export default defineEventHandler(event => apiData({ ...requirePlatform(event), hostBase: hostConfig().base }))
