import { personListQuerySchema } from '../../../../shared/schemas/people'
import { requireScope } from '../../../services/access'
import { listPeople } from '../../../services/people'
import { apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.view')
  const parsed = personListQuerySchema.safeParse(getQuery(event))
  if (!parsed.success) {
    return apiError(event, 400, 'validation_failed', 'Невірні параметри', { issues: parsed.error.issues })
  }
  const result = await listPeople(
    { tenantId: access.tenantId, actorId: access.userId },
    parsed.data,
  )
  return { data: result.items, meta: { cursor: result.cursor, limit: parsed.data.limit } }
})
