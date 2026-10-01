import { requireScope } from '../../../../services/access'
import { assertPersonAccess } from '../../../../services/personGuard'
import { setBlocked } from '../../../../services/people'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** Блокування входу (docs/16 §7.4): навчання лишається, сесії закриваються. */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.deactivate')
  await assertPersonAccess(access, 'people.deactivate', getRouterParam(event, 'id')!, { sensitive: true })
  const r = await setBlocked({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!, true)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Людину не знайдено')
    if (r.code === 'last_owner') return apiError(event, 409, 'last_owner', 'Це власник простору — спочатку передайте володіння іншій людині')
    return apiError(event, 409, 'last_admin', 'Це останній адміністратор — спочатку призначте іншого')
  }
  return apiData({ ok: true })
})
