import { requireScope } from '../../../../../services/access'
import { dismissNotice } from '../../../../../services/limitNotices'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/**
 * POST /billing/notices/:id/dismiss (docs/v2/35 §10, §7.9 п. 2): крестик прячет баннер на
 * 24 часа. У уровня `exceeded` крестика нет — `409`, как и написано в таблице API.
 * Чужой тенант не найдёт запись вовсе: выборка идёт под RLS — `404`, а не `403` (CLAUDE.md п. 15).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'billing.view')
  const id = getRouterParam(event, 'id')!
  const r = await dismissNotice({ tenantId: a.tenantId, actorId: a.userId }, id)
  if (r.ok) return apiData(r)
  if (r.code === 'cannot_dismiss_exceeded') {
    return apiError(event, 409, 'limit_exceeded', 'Попередження про вичерпаний ліміт закрити не можна')
  }
  return apiError(event, 404, 'not_found', 'Попередження не знайдено')
})
