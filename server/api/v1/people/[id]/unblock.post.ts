import { requireScope } from '../../../../services/access'
import { assertPersonAccess } from '../../../../services/personGuard'
import { setBlocked } from '../../../../services/people'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.deactivate')
  await assertPersonAccess(access, 'people.deactivate', getRouterParam(event, 'id')!, { sensitive: true })
  const r = await setBlocked({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!, false)
  if (!r.ok) return apiError(event, 404, 'not_found', 'Людину не знайдено')
  return apiData({ ok: true })
})
