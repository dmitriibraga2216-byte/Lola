import { getQuery } from 'h3'
import { requireScope } from '../../../services/access'
import { listTenantPayments } from '../../../services/billing'
import { tenantPaymentsQuerySchema } from '../../../../shared/schemas/billing'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * GET /billing/payments (docs/v2/35-billing-limits.md §5.3, §9, §10): «Історія платежів».
 * Тільки `owner` (`billing.payments.view`) — `403`, а не часткові дані (§13 к. 10).
 */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'billing.payments.view')
  const raw = getQuery(event)
  const q = tenantPaymentsQuerySchema.safeParse({
    from: raw.from, to: raw.to, kind: raw.kind, status: raw.status, cursor: raw.cursor,
    limit: raw.limit ? Number(raw.limit) : undefined,
  })
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Некоректні параметри фільтра', { issues: q.error.issues })
  const result = await listTenantPayments(access.tenantId, q.data)
  return apiData(result)
})
