import { tenantPaymentSchema } from '../../../../../../shared/schemas/billing'
import { requirePlatform } from '../../../../../utils/platformGuard'
import { recordTenantPayment } from '../../../../../services/platformTenants'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/**
 * POST /platform/tenants/:id/payments (docs/v2/35-billing-limits.md §10, §7.10, §7.8 п. 6):
 * приём платежа оператором вручную — обходной путь на отсутствие платёжного провайдера
 * (`docs/v2/44-decisions.md` §8, `HANDOFF` §6). Продление подписки (`kind='subscription'`)
 * считается от прежней `paid_until`, не от даты платежа — `recordTenantPayment`.
 */
export default defineEventHandler(async (event) => {
  const actor = requirePlatform(event)
  const p = tenantPaymentSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте суму, вид платежу та коментар (10–500 знаків)', { issues: p.error.issues })
  const r = await recordTenantPayment(getRouterParam(event, 'id')!, p.data, actor)
  if (!r.ok) return apiError(event, r.code === 'not_found' ? 404 : 422, r.code, r.code === 'not_found' ? 'Тенант не знайдено' : 'Опцію не знайдено в каталозі')
  return apiData(r)
})
