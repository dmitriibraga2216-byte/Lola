import { ZodError } from 'zod'
import { policiesPatchSchema } from '../../../../shared/schemas/settings'
import { requireScope } from '../../../services/access'
import { updatePolicies } from '../../../services/settings'
import { apiData, apiError } from '../../../utils/apiResponse'
/** PATCH /settings/policies: пачкой («Зберегти» на экране), любые группы частично; audit diff + security_log. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = policiesPatchSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте значення політик', { issues: p.error.issues })
  try {
    return apiData(await updatePolicies({ tenantId: a.tenantId, actorId: a.userId }, p.data))
  }
  catch (e) {
    // Диапазоны (1–90 днів и т. п.) проверяет полная схема при слиянии
    if (e instanceof ZodError) return apiError(event, 400, 'validation_failed', 'Перевірте значення політик', { issues: e.issues })
    throw e
  }
})
