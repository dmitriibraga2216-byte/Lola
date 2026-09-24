import { can, requireScope } from '../../../services/access'
import { billingSummary } from '../../../services/billing'
import { apiData } from '../../../utils/apiResponse'

/**
 * GET /billing/summary (docs/v2/35-billing-limits.md §5.1, §10): план, ціна, статус підписки,
 * блок ШІ, активні аддони. Скоуп `billing.view` бачать `admin` і `owner`; ціну — лише `owner`
 * (`billing.payments.view`, `35` §2: «у admin ціна скрита»).
 */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'billing.view')
  const summary = await billingSummary(access.tenantId, can(access, 'billing.payments.view'))
  return apiData(summary)
})
