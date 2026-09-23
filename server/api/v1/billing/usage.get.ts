import { requireScope } from '../../../services/access'
import { usageByAxis } from '../../../services/usageCounters'
import { apiData } from '../../../utils/apiResponse'

/**
 * GET /billing/usage (docs/v2/35-billing-limits.md §10): потребление по одиннадцати осям —
 * `axis, used, limit, pct, source (live | counter)`, плюс окно биллингового периода и то,
 * что перестаёт работать при превышении (§7.1, столбец «При исчерпании»).
 *
 * Скоуп `billing.usage.view` (§2): счётчики видят `admin` и `owner`, суммы — только `owner`
 * (`/billing/payments`, PR-10). Число здесь — то же, по которому операция блокируется:
 * лимит считает одна функция `effectiveLimits()` (§7.3, решение docs/v2/44 В-5).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'billing.usage.view')
  const axes = await usageByAxis(a.tenantId)
  return apiData({ axes, periodStart: axes[0]?.periodStart ?? null, periodEnd: axes[0]?.periodEnd ?? null })
})
