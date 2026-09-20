import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { sessionsDailyAvg } from '../../../../services/logs'
import { apiData, apiError } from '../../../../utils/apiResponse'

const querySchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) })

/**
 * GET /logs/sessions/daily — графік «Середній час у системі» журналу сесій (docs/28 «Spec 22»
 * отк. (4), D-003): середня тривалість сесії по днях за період.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'audit.view')
  const q = querySchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Перевірте параметри', { issues: q.error.issues })
  const days = await sessionsDailyAvg({ tenantId: a.tenantId, actorId: a.userId }, q.data.days)
  return apiData({ days })
})
