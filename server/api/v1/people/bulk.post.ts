import { bulkSchema } from '../../../../shared/schemas/people'
import { requireScope } from '../../../services/access'
import { bulkPeople } from '../../../services/people'
import { apiData, apiError } from '../../../utils/apiResponse'

/** Масові дії зі списку (docs/16 §5.1). */
export default defineEventHandler(async (event) => {
  const parsed = bulkSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Перевірте параметри дії', { issues: parsed.error.issues })
  const scope = parsed.data.action === 'archive' ? 'people.deactivate' : parsed.data.action === 'assign_role' ? 'role.assign' : parsed.data.action === 'invite' ? 'people.invite' : 'people.edit'
  const access = await requireScope(event, scope)
  return apiData(await bulkPeople({ tenantId: access.tenantId, actorId: access.userId }, parsed.data))
})
