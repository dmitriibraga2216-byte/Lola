import { requireScope } from '../../../../services/access'
import { getQualityReview } from '../../../../services/aiQuality'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** GET /ai/quality-reviews/:id — перепроверка с самим выводом модели (`docs/v2/30` §10; `ai.audit`). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'ai.audit')
  const r = await getQualityReview({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  return r ? apiData(r) : apiError(event, 404, 'not_found', 'Перевірку не знайдено')
})
