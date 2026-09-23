import { offboardingListSchema } from '../../../../shared/schemas/offboarding'
import { requireScope } from '../../../services/access'
import { listCases } from '../../../services/offboarding'
import { apiData, apiError } from '../../../utils/apiResponse'

/** GET /offboarding — список случаев увольнения (docs/v2/33 §5.4, §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'offboarding.start')
  const p = offboardingListSchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте фільтри', { issues: p.error.issues })
  return apiData(await listCases({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
