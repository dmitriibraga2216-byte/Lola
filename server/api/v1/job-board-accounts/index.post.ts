import { jobBoardAccountCreateSchema } from '../../../../shared/schemas/vacancies'
import { OWNER_ROLE_CODE } from '../../../../shared/domain/roles'
import { requireScope } from '../../../services/access'
import { connectAccount } from '../../../services/jobBoardAccounts'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * POST /job-board-accounts — подключение (docs/v2/29 §7.14, §10, план `45` PR-17).
 *
 * Синхронное: заглушка не делает сетевого вызова, поэтому здесь нет пары `auth-url`/`callback`
 * из документа — `[решение]`, см. `server/services/jobBoardAdapter.ts`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'jobboard.connect')
  const p = jobBoardAccountCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте дані підключення', { issues: p.error.issues })
  const isAdmin = a.roles.some(r => r.code === 'admin' || r.code === OWNER_ROLE_CODE)
  const r = await connectAccount({ tenantId: a.tenantId, actorId: a.userId, isAdmin }, p.data)
  if (r.ok) return apiData(r.account)
  switch (r.code) {
    case 'forbidden':
      return apiError(event, 403, 'jobboard.owner_forbidden', 'Немає прав підключити такий акаунт')
    case 'owner_required':
      return apiError(event, 422, 'validation_failed', 'Оберіть рекрутера для цього акаунта')
    default:
      return apiError(event, 422, 'validation_failed', 'Обраний співробітник не знайдений')
  }
})
