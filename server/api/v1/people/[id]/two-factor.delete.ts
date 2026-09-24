import { requireScope } from '../../../../services/access'
import { resetByAdmin } from '../../../../services/twoFactor'
import { apiData } from '../../../../utils/apiResponse'
import { twoFactorError } from '../../../../utils/sessionAuth'

/**
 * DELETE /people/:id/two-factor (docs/04 §4.11, docs/24 §3.4): администратор снимает второй
 * фактор человеку, потерявшему телефон и резервные коды. Скоуп `people.password` — «учётные
 * данные другого человека», он `sessionOnly` (docs/v2/44 В-20): по токену интеграции второй
 * фактор не снимается никогда. Закрываются все сессии человека; `two_factor.reset` (critical).
 * Чужой тенант и несуществующий человек — 404 (CLAUDE.md п. 15); себе — нельзя (`409`).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'people.password')
  const r = await resetByAdmin({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) return twoFactorError(event, r.code)
  return apiData({ ok: true })
})
