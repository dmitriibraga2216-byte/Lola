import { requirePlatform, tenantActionError } from '../../../../../utils/platformGuard'
import { resumeTenant } from '../../../../../services/platformTenants'
import { apiData } from '../../../../../utils/apiResponse'

/** POST /platform/tenants/:id/resume — возобновление из suspended. */
export default defineEventHandler(async (event) => {
  const actor = requirePlatform(event, 'tenant.suspend')
  const r = await resumeTenant(getRouterParam(event, 'id')!, actor)
  return r.ok ? apiData(r) : tenantActionError(event, r.code)
})
