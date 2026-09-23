import { candidateBulkStatusSchema } from '../../../../../shared/schemas/candidates'
import { requireScope } from '../../../../services/access'
import { viewerOf } from '../../../../services/candidates'
import { bulkStatus } from '../../../../services/candidateFunnel'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /candidates/bulk/status — массовая смена колонки (docs/v2/28 §6.3, §10).
 * Пропущенные возвращаются поимённо с причиной: «перенесено 7 із 10» без объяснения
 * заставляет рекрутера искать три карточки вручную.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.decide')
  const p = candidateBulkStatusSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте список і колонку', { issues: p.error.issues })
  const r = await bulkStatus(viewerOf(a), p.data)
  if (!r.ok) return apiError(event, 404, 'not_found', 'Колонку воронки не знайдено')
  return apiData({ changed: r.changed, skipped: r.skipped })
})
