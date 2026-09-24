import { storageSummaryQuerySchema } from '../../../../shared/schemas/storage'
import { requireScope } from '../../../services/access'
import { storageSummary } from '../../../services/storage'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * `GET /storage/summary?groupBy=origin|stage` (docs/v2/34 §5.1, §10): «Використовується: {used} /
 * {limit}», разбивка «За походженням» или «За етапом» (девять ключей, решение В-10), срез для
 * счёта и дрейф. Лимит — из `effectiveLimits()` (одна формула с баннером и счётом, `44` В-5).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'storage.view')
  const q = storageSummaryQuerySchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Невідомий режим розбивки')
  return apiData(await storageSummary({ tenantId: a.tenantId, actorId: a.userId }, q.data.groupBy))
})
