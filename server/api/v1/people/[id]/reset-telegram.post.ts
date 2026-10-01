import { requireScope } from '../../../../services/access'
import { assertPersonAccess } from '../../../../services/personGuard'
import { resetTelegram } from '../../../../services/people'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.edit')
  await assertPersonAccess(access, 'people.edit', getRouterParam(event, 'id')!, { sensitive: true })
  const ok = await resetTelegram({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!)
  if (!ok) return apiError(event, 404, 'not_found', 'Людину не знайдено')
  return apiData({ ok: true })
})
