import { requireScope } from '../../../../services/access'
import { requestPlanChange } from '../../../../services/planChange'
import { planChangeSchema } from '../../../../../shared/schemas/billing'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { planChangeError } from '../../../../utils/planChangeErrors'

/**
 * POST /billing/plan-change (docs/v2/35 §6.1, §7.6 п. 2–3, §10): «Підключити». Без превышений —
 * заявка `scheduled` с первого дня следующего оплаченного периода; с превышениями — единый
 * `409 limit_exceeded` с `details.blockers`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'billing.manage')
  const p = planChangeSchema.safeParse(await readBody(event))
  if (!p.success) {
    const confirm = p.error.issues.some(i => i.path[0] === 'confirm')
    return apiError(event, 422, 'validation_failed', confirm ? 'Підтвердьте, що ознайомились із новими лімітами' : 'Оберіть тариф і період оплати', { issues: p.error.issues })
  }
  const r = await requestPlanChange({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (r.ok) return apiData(r)
  if (r.code === 'limit_exceeded') {
    return apiError(event, 409, 'limit_exceeded', 'Щоб перейти на цей тариф, зменшіть використання до нових лімітів', { blockers: r.request.blockers, requestId: r.request.id })
  }
  return planChangeError(event, r.code)
})
