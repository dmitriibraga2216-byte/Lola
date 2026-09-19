import { requirePlatform } from '../../../../../utils/platformGuard'
import { tenantUsers } from '../../../../../services/platform'
import { apiData } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => { requirePlatform(event); return apiData(await tenantUsers(getRouterParam(event, 'id')!)) })
