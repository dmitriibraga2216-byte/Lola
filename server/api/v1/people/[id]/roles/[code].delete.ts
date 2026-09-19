import { roleRevokeSchema } from '../../../../../../shared/schemas/people'
import { requireScope } from '../../../../../services/access'
import { removeRole } from '../../../../../services/people'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** Зняти роль (docs/16 §6.2): причина — в аудит (`?reason=`), останнього адміністратора не позбавити. */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'role.assign')
  const parsed = roleRevokeSchema.safeParse(getQuery(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля', { issues: parsed.error.issues })
  const r = await removeRole({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!, getRouterParam(event, 'code')!, parsed.data.reason)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Роль у цієї людини не знайдено')
    return apiError(event, 409, 'last_admin', 'Це останній адміністратор — спочатку призначте іншого')
  }
  return apiData({ ok: true })
})
