import { twoFactorPlatformResetSchema } from '../../../../../../../../shared/schemas/twoFactor'
import { recordPlatformAudit } from '../../../../../../../services/platformTenants'
import { resetByPlatform } from '../../../../../../../services/twoFactor'
import { apiData, apiError } from '../../../../../../../utils/apiResponse'
import { requirePlatform } from '../../../../../../../utils/platformGuard'
import { twoFactorError } from '../../../../../../../utils/sessionAuth'

/**
 * POST /platform/tenants/:id/users/:userId/two-factor-reset (docs/04 §4.17, docs/24 §3.4):
 * последний способ вернуть вход администратору, потерявшему и телефон, и резервные коды, когда
 * другого администратора нет. Причина 10–500 знаков (как у входа «от имени», docs/24 §4.5);
 * событие `two_factor.reset` (critical) — в журнал безопасности тенанта, действие — в журнал
 * платформы. Панель оператора — только по cookie `lola_ops`: Bearer-токен тенанта сюда не
 * доходит вовсе (`01.session.ts` разбирает `/api/v1/platform/*` раньше ветки Bearer).
 */
export default defineEventHandler(async (event) => {
  const op = requirePlatform(event)
  const p = twoFactorPlatformResetSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Опишіть причину — це побачить клієнт у своєму журналі', { issues: p.error.issues })
  const tenantId = getRouterParam(event, 'id')!
  const userId = getRouterParam(event, 'userId')!
  const r = await resetByPlatform(tenantId, userId, p.data.reason, op)
  if (!r.ok) return twoFactorError(event, r.code)
  await recordPlatformAudit(op, { action: 'tenant.two_factor_reset', tenantId, entity: 'user', entityId: userId, after: { reason: p.data.reason } })
  return apiData({ ok: true })
})
