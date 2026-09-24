import { platformExtendSchema } from '../../../../../../shared/schemas/billing'
import { requirePlatform } from '../../../../../utils/platformGuard'
import { extendTenantDates } from '../../../../../services/platformTenants'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/**
 * POST /platform/tenants/:id/extend (docs/v2/35-billing-limits.md §5.6, §7.10): точечно
 * сдвинуть `paid_until`/`grace_until`/`ai_until` без платежа — «Продовжити доступ»,
 * «Продовжити ШІ». Только переданные поля меняются, остальные даты подписки не трогаются.
 */
export default defineEventHandler(async (event) => {
  const actor = requirePlatform(event)
  const p = platformExtendSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте дати та причину (10–500 знаків)', { issues: p.error.issues })
  const { comment: _comment, ...dates } = p.data
  const r = await extendTenantDates(getRouterParam(event, 'id')!, dates, actor)
  if (!r.ok) return apiError(event, 404, 'not_found', 'Тенант не знайдено')
  return apiData(r)
})
