import { z } from 'zod'
import { operatorTwoFactorResetSchema } from '../../../../../../shared/schemas/platformOperators'
import { resetForOperator } from '../../../../../services/platformTwoFactor'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { requirePlatform } from '../../../../../utils/platformGuard'

/**
 * POST /platform/operators/:id/two-factor-reset {reason} — сброс второго фактора оператору, потерявшему
 * телефон и коды (docs/25 §7 п. 8). Только `owner`, с причиной; сессии оператора гаснут; в `platform_audit`.
 */
export default defineEventHandler(async (event) => {
  const actor = requirePlatform(event, 'operators.two_factor_reset')
  const id = getRouterParam(event, 'id')!
  if (!z.string().uuid().safeParse(id).success) return apiError(event, 404, 'not_found', 'Оператора не знайдено')
  const p = operatorTwoFactorResetSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Опишіть причину (10–500 символів)')
  const r = await resetForOperator(actor, id, p.data.reason)
  if (r.ok) return apiData({ ok: true })
  if (r.code === 'self') return apiError(event, 409, 'operator.self', 'Свій другий фактор замінюйте кодом зі свого застосунку')
  return apiError(event, 404, 'not_found', 'Оператора не знайдено')
})
