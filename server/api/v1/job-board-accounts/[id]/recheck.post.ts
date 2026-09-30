import { OWNER_ROLE_CODE } from '../../../../../shared/domain/roles'
import { requireScope } from '../../../../services/access'
import { recheckAccount } from '../../../../services/vacancyPublications'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /job-board-accounts/:id/recheck — «Спробувати ще раз» на карточке площадки
 * (docs/v2/29 §5.4, docs/09 §9.3): та же проверка `health()`, что у `vacancy.publication_health`,
 * сразу. Ответ — итог: `ok` (снова «Підключено»), `failing` («Мовчить»), `revoked`, `skipped`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'jobboard.connect')
  const isAdmin = a.roles.some(r => r.code === 'admin' || r.code === OWNER_ROLE_CODE)
  const r = await recheckAccount({ tenantId: a.tenantId, actorId: a.userId, isAdmin }, getRouterParam(event, 'id')!)
  if (r.ok) return apiData({ outcome: r.outcome })
  return apiError(event, 404, 'not_found', 'Акаунт не знайдено')
})
