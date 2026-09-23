import { requireScope } from '../../../../services/access'
import { claimOwnership } from '../../../../services/owner'
import { apiData } from '../../../../utils/apiResponse'
import { ownerError } from './_errors'

/**
 * POST /settings/owner/claim — «Стати власником» (docs/01 §1.9.4).
 *
 * Одноразове дію адміністратора в просторі **без власника**: міграція `0070_owner_role`
 * завела роль, але нікому її не видала (роздавати володіння по всій базі мовчки не можна —
 * див. шапку міграції). Скоуп `settings.tenant` — той самий, що відкриває екран ролей;
 * `tenant.transfer` тут вимагати не можна, бо його ще ні в кого немає.
 * Гонку двох адміністраторів вирішує частковий унікальний індекс, а не ця перевірка.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const r = await claimOwnership({ tenantId: a.tenantId, actorId: a.userId })
  if (!r.ok) return ownerError(event, r.code)
  return apiData(r.owner)
})
