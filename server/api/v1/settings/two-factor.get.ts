import { requireScope } from '../../../services/access'
import { twoFactorOverview } from '../../../services/twoFactor'
import { apiData } from '../../../utils/apiResponse'

/**
 * GET /settings/two-factor (docs/24 §3.4, П-24.1): блок «Двофакторна автентифікація» настроек
 * компании — включена ли вимога для адміністраторів и кто из них уже підключив фактор. Сама
 * вимога — ключ `policies.passwords.adminTwoFactor`, пишется `PATCH /settings/policies`
 * (`422 two_factor_enroll_first`, если у включающего фактора нет).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  return apiData(await twoFactorOverview({ tenantId: a.tenantId, actorId: a.userId }))
})
