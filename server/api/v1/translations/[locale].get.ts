import { z } from 'zod'
import type { AuthContext } from '../../../services/session'
import { tenantOverrides } from '../../../services/translations'
import { apiData, apiError } from '../../../utils/apiResponse'
/** GET /translations/:locale — переопределения тенанта для клиента, накладываются поверх словаря (docs/24 §7.4). */
export default defineEventHandler(async (event) => {
  const auth = event.context.auth as AuthContext | undefined
  if (!auth) return apiError(event, 401, 'auth_required', 'Потрібен вхід')
  const p = z.enum(['uk', 'en', 'ru']).safeParse(getRouterParam(event, 'locale'))
  if (!p.success) return apiError(event, 404, 'not_found', 'Мову не знайдено')
  return apiData(await tenantOverrides(auth.tenantId, p.data))
})
