import { requireScope } from '../../../../services/access'
import { listRoles, SCOPE_GROUPS } from '../../../../services/roles'
import { apiData } from '../../../../utils/apiResponse'
/** GET /settings/roles (docs/24 §3.5): роли со счётчиками скоупов и людей; группы скоупов для редактора. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'people.view')
  const roles = await listRoles({ tenantId: a.tenantId, actorId: a.userId })
  return apiData(Object.assign(roles, { groups: SCOPE_GROUPS }))
})
