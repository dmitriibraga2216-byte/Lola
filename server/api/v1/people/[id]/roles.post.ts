import { roleAssignSchema } from '../../../../../shared/schemas/people'
import { requireScope } from '../../../../services/access'
import { assignRole } from '../../../../services/people'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'role.assign')
  const parsed = roleAssignSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    return apiError(event, 400, 'validation_failed', 'Перевірте поля', { issues: parsed.error.issues })
  }
  const assigned = await assignRole(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
    parsed.data,
  )
  if (!assigned) return apiError(event, 404, 'not_found', 'Роль не знайдено')
  return apiData(assigned)
})
