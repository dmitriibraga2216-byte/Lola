import { getQuery } from 'h3'
import { aiCallsQuerySchema } from '../../../../../shared/schemas/ai'
import { requireScope } from '../../../../services/access'
import { listAiCalls } from '../../../../services/ai/calls'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * GET /ai/calls — журнал вызовов модели (`docs/v2/30` §2, §5.6, §10): фильтры назначения,
 * статуса и периода, ключевой курсор (`docs/04` §4.1). Скоуп `ai.audit`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'ai.audit')
  const raw = getQuery(event)
  const q = aiCallsQuerySchema.safeParse({
    purpose: raw.purpose, status: raw.status, from: raw.from, to: raw.to, cursor: raw.cursor,
    limit: raw.limit ? Number(raw.limit) : undefined,
  })
  if (!q.success) return apiError(event, 400, 'validation_failed', q.error.issues[0]?.message ?? 'Некоректні параметри фільтра', { issues: q.error.issues })
  return apiData(await listAiCalls({ tenantId: a.tenantId, actorId: a.userId }, q.data))
})
