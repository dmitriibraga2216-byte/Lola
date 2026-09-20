import { birthdaysQuerySchema } from '../../../shared/schemas/hub'
import { requireScope } from '../../services/access'
import { birthdays } from '../../services/hubPeople'
import { apiData, apiError } from '../../utils/apiResponse'

/** GET /birthdays?tab=upcoming|past&from=&to= — дни рождения за период (docs/21 §14.7). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = birthdaysQuerySchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте період')
  return apiData(await birthdays({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
