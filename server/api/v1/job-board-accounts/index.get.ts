import { OWNER_ROLE_CODE } from '../../../../shared/domain/roles'
import { requireScope } from '../../../services/access'
import { listAccounts } from '../../../services/jobBoardAccounts'
import { apiData } from '../../../utils/apiResponse'

/**
 * GET /job-board-accounts — карточки площадок, сгруппированные по владельцу (docs/v2/29 §5.4, §10).
 * Группировка — на фронтенде: сервис отдаёт плоский список с `ownerType`/`ownerUserId`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'jobboard.connect')
  const isAdmin = a.roles.some(r => r.code === 'admin' || r.code === OWNER_ROLE_CODE)
  return apiData({ items: await listAccounts({ tenantId: a.tenantId, actorId: a.userId, isAdmin }) })
})
