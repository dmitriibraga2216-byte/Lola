import { platformPlanChangeSchema } from '../../../../../../shared/schemas/billing'
import { requirePlatform } from '../../../../../utils/platformGuard'
import { changeTenantPlan } from '../../../../../services/platformTenants'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/**
 * POST /platform/tenants/:id/plan-change (docs/v2/35-billing-limits.md §7.10, §5.6): оператор
 * назначает тенанту любой план напрямую, без preflight превышений — эта проверка защищает
 * самообслуживание владельца (`35` §6.1, экран §5.2 и `/billing/plan-change/*` — отдельный
 * PR, см. `docs/v2/46-progress.md`), а не решение оператора.
 */
export default defineEventHandler(async (event) => {
  const actor = requirePlatform(event)
  const p = platformPlanChangeSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Оберіть тариф, період і вкажіть причину (10–500 знаків)', { issues: p.error.issues })
  const r = await changeTenantPlan(getRouterParam(event, 'id')!, p.data, actor)
  if (!r.ok) return apiError(event, r.code === 'not_found' ? 404 : 422, r.code, r.code === 'not_found' ? 'Тенант не знайдено' : 'Такого тарифу немає')
  return apiData(r)
})
