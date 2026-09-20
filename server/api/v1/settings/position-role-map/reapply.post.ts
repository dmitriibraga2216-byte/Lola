import { requireScope } from '../../../../services/access'
import { reapplyPositionRolesNetwork } from '../../../../services/positionRoleMap'
import { apiData } from '../../../../utils/apiResponse'

/**
 * POST /settings/position-role-map/reapply — «Перезібрати ролі по мережі» (docs/28 «Паритет 4»
 * отк. (2)): применяет текущую карту «должность → роль» ко всем действующим основным размещениям
 * тенанта сразу, не дожидаясь следующей смены должности или импорта.
 */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'settings.tenant')
  const r = await reapplyPositionRolesNetwork({ tenantId: access.tenantId, actorId: access.userId })
  return apiData(r)
})
