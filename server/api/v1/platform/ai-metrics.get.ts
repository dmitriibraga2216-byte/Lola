import { aiOperatorMetricsQuerySchema } from '../../../../shared/schemas/ai'
import { aiOperatorMetrics } from '../../../services/ai/operatorMetrics'
import { requirePlatform } from '../../../utils/platformGuard'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * GET /platform/ai-metrics — журнал ИИ-вызовов оператору платформы, **только метрики**
 * (`docs/v2/30` §2, `44` Р-AI2.4): задержка, токены, стоимость, статусы по тенанту, роли и модели.
 * Содержимого вызовов, ссылок на людей и отдельных вызовов нет.
 */
export default defineEventHandler(async (event) => {
  requirePlatform(event, 'platform.read')
  const p = aiOperatorMetricsQuerySchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте фільтри', { issues: p.error.issues })
  return apiData(await aiOperatorMetrics(p.data))
})
