import { requireScope } from '../../../../services/access'
import { getPositionRoleMap } from '../../../../services/positionRoleMap'
import { apiData } from '../../../../utils/apiResponse'

/** GET /settings/position-role-map — правило «должность → роль» (docs/04 §4.13, docs/01 §1.9.3). */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'role.assign')
  return apiData(await getPositionRoleMap({ tenantId: access.tenantId, actorId: access.userId }))
})
