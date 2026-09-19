import { requireScope } from '../../../../../services/access'
import { removeRole } from '../../../../../services/people'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** Зняти роль (docs/16 §6.2): останнього адміністратора не позбавити. */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'role.assign')
  const r = await removeRole({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!, getRouterParam(event, 'code')!)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Роль у цієї людини не знайдено')
    return apiError(event, 409, 'last_admin', 'Це останній адміністратор — спочатку призначте іншого')
  }
  return apiData({ ok: true })
})
