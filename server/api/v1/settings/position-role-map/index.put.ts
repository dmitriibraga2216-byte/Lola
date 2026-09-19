import { positionRoleMapSchema } from '../../../../../shared/schemas/people'
import { requireScope } from '../../../../services/access'
import { setPositionRoleMap } from '../../../../services/positionRoleMap'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** PUT /settings/position-role-map — замена правила целиком; применяется при следующей смене должности или импорте. */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'settings.tenant')
  const parsed = positionRoleMapSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля', { issues: parsed.error.issues })
  const r = await setPositionRoleMap({ tenantId: access.tenantId, actorId: access.userId }, parsed.data.items)
  if (!r.ok) return apiError(event, 404, 'not_found', 'Посаду або роль не знайдено', { detail: r.detail })
  return apiData({ count: r.count })
})
