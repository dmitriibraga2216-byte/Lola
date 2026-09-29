import { can, requireScope } from '../../../services/access'
import { planCatalog } from '../../../services/planChange'
import { apiData } from '../../../utils/apiResponse'

/**
 * GET /billing/plans (docs/v2/35-billing-limits.md §5.2, §10): тарифы каталога по тиру и `sort`,
 * лимиты по осям, направление относительно текущего и превышения для тиров ниже — то, что делает
 * «Підключити» неактивной (§13 к. 7). Цены — только владельцу (`billing.payments.view`, §2).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'billing.view')
  return apiData(await planCatalog(a.tenantId, can(a, 'billing.payments.view')))
})
