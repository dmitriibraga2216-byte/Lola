import { requireScope } from '../../../../services/access'
import { deleteRole } from '../../../../services/roles'
import { apiData } from '../../../../utils/apiResponse'
import { roleError } from './_errors'
/** DELETE /settings/roles/:id: только свою роль, не выданную людям. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const r = await deleteRole({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) return roleError(event, r.code, r.details)
  return apiData({ ok: true })
})
