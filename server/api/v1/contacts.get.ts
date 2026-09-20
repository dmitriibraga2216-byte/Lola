import { contactsQuerySchema } from '../../../shared/schemas/hub'
import { requireScope } from '../../services/access'
import { contacts } from '../../services/hubPeople'
import { apiData, apiError } from '../../utils/apiResponse'

/** GET /contacts — справочник людей (docs/21 §14.8): личные поля только тем, кому положено. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = contactsQuerySchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри')
  return apiData(await contacts({ tenantId: a.tenantId, actorId: a.userId }, a, p.data))
})
