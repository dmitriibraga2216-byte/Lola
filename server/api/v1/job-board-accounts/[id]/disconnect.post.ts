import { OWNER_ROLE_CODE } from '../../../../../shared/domain/roles'
import { requireScope } from '../../../../services/access'
import { disconnectAccount } from '../../../../services/jobBoardAccounts'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** POST /job-board-accounts/:id/disconnect — отключение владельцем (docs/v2/29 §7.14, §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'jobboard.connect')
  const isAdmin = a.roles.some(r => r.code === 'admin' || r.code === OWNER_ROLE_CODE)
  const r = await disconnectAccount({ tenantId: a.tenantId, actorId: a.userId, isAdmin }, getRouterParam(event, 'id')!)
  if (r.ok) return apiData({ ok: true })
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Акаунт не знайдено')
  return apiError(event, 403, 'forbidden', 'Немає доступу до цього акаунта')
})
