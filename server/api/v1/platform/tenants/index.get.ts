import { requirePlatform } from '../../../../utils/platformGuard'
import { listTenants } from '../../../../services/platform'
import { apiData } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => { requirePlatform(event, 'tenant.read'); return apiData(await listTenants()) })
