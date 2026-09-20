import { requirePlatform, tenantActionError } from '../../../../../utils/platformGuard'
import { cancelPurge } from '../../../../../services/platformTenants'
import { apiData } from '../../../../../utils/apiResponse'

/** DELETE /platform/tenants/:id/purge — отмена удаления до срока: archived → suspended. */
export default defineEventHandler(async (event) => {
  const actor = requirePlatform(event)
  const r = await cancelPurge(getRouterParam(event, 'id')!, actor)
  return r.ok ? apiData(r) : tenantActionError(event, r.code)
})
