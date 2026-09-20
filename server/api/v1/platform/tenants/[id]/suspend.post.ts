import { tenantSuspendSchema } from '../../../../../../shared/schemas/platform'
import { requirePlatform, tenantActionError } from '../../../../../utils/platformGuard'
import { suspendTenant } from '../../../../../services/platformTenants'
import { apiData } from '../../../../../utils/apiResponse'

/** POST /platform/tenants/:id/suspend {reason?} — приостановка (docs/25 §8): вход закрыт, задачи стоят, данные целы. */
export default defineEventHandler(async (event) => {
  const actor = requirePlatform(event)
  const p = tenantSuspendSchema.safeParse((await readBody(event)) ?? {})
  const r = await suspendTenant(getRouterParam(event, 'id')!, p.success ? p.data.reason ?? null : null, actor)
  return r.ok ? apiData(r) : tenantActionError(event, r.code)
})
