import { requireScope } from '../../../../services/access'
import { activeNotices } from '../../../../services/limitNotices'
import { apiData } from '../../../../utils/apiResponse'

/**
 * GET /billing/notices (docs/v2/35 §10): открытые предупреждения для баннера (§5.5, §7.9).
 * Скрытые крестиком не возвращаются, пока не истекли 24 часа; `exceeded` возвращается всегда —
 * его закрыть нельзя. Видят только `admin` и `owner` (§2): сотрудник баннера не видит никогда.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'billing.view')
  return apiData(await activeNotices(a.tenantId))
})
