import { requireScope } from '../../../../services/access'
import { assertPersonAccess } from '../../../../services/personGuard'
import { createInvitation } from '../../../../services/people'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.invite')
  await assertPersonAccess(access, 'people.invite', getRouterParam(event, 'id')!, { sensitive: true })
  const invite = await createInvitation(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
  )
  if (!invite) return apiError(event, 404, 'not_found', 'Людину не знайдено')
  return apiData(invite)
})
