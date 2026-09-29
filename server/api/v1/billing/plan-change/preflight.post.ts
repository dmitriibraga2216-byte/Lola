import { requireScope } from '../../../../services/access'
import { preflightPlanChange } from '../../../../services/planChange'
import { planChangePreflightSchema } from '../../../../../shared/schemas/billing'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { planChangeError } from '../../../../utils/planChangeErrors'

/**
 * POST /billing/plan-change/preflight (docs/v2/35 §7.6 п. 1, 3, 4, §10): предпросмотр перехода
 * вниз и «Перерахувати» — заявка `preflight` или `blocked` с превышениями по осям. Сервер
 * считает, сколько освободить (`excess`), экран только показывает (CLAUDE.md п. 3).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'billing.manage')
  const p = planChangePreflightSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Оберіть тариф і період оплати', { issues: p.error.issues })
  const r = await preflightPlanChange({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r.ok) return planChangeError(event, r.code)
  return apiData(r)
})
