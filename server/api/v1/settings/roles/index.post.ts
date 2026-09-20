import { roleCreateSchema } from '../../../../../shared/schemas/settings'
import { requireScope } from '../../../../services/access'
import { createRole } from '../../../../services/roles'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { roleError } from './_errors'
/** POST /settings/roles: своя роль тенанта. Код `^[a-z_]{3,40}$`, уникален. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = roleCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.path[0] === 'code' ? 'Код латиницею, без пробілів' : 'Перевірте поля', { issues: p.error.issues })
  const r = await createRole({ tenantId: a.tenantId, actorId: a.userId }, a, p.data)
  if (!r.ok) return roleError(event, r.code, r.details)
  return apiData(r.role)
})
