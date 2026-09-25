import { getQuery } from 'h3'
import { aiQualityListSchema } from '../../../../../shared/schemas/ai'
import { requireScope } from '../../../../services/access'
import { listQualityReviews } from '../../../../services/aiQuality'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * GET /ai/quality-reviews — очередь выборочной перепроверки вывода модели (`docs/v2/30` §7.16, §10;
 * `ai.audit`): непроверенные, проверенные или все, по виду вывода, ключевой курсор.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'ai.audit')
  const raw = getQuery(event)
  const q = aiQualityListSchema.safeParse({ status: raw.status, refKind: raw.refKind, cursor: raw.cursor, limit: raw.limit })
  if (!q.success) return apiError(event, 400, 'validation_failed', q.error.issues[0]?.message ?? 'Некоректні параметри', { issues: q.error.issues })
  return apiData(await listQualityReviews({ tenantId: a.tenantId, actorId: a.userId }, q.data))
})
