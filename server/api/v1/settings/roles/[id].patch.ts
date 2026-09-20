import { rolePatchSchema } from '../../../../../shared/schemas/settings'
import { requireScope } from '../../../../services/access'
import { updateRole } from '../../../../services/roles'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { roleError } from './_errors'
/** PATCH /settings/roles/:id: название, описание, скоупы, область по умолчанию. Защиты — в сервисе. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = rolePatchSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля', { issues: p.error.issues })
  const r = await updateRole({ tenantId: a.tenantId, actorId: a.userId }, a, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) return roleError(event, r.code, r.details)
  return apiData(r.role)
})
