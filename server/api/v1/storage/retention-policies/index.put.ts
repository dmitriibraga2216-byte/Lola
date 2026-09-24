import { retentionPoliciesSaveSchema } from '../../../../../shared/schemas/storage'
import { requireScope } from '../../../../services/access'
import { saveRetentionPolicies } from '../../../../services/storagePolicies'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * `PUT /storage/retention-policies` (docs/v2/34 §6.2, §7.3, §10). Первое включение удаляющей
 * политики — только после сухого прогона (`422 dry_run_required`); `keepEvidence=false` — только
 * с отметкой «Розумію, що буде видалено підтвердження оцінок» (`422 evidence_ack_required`).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'storage.policy')
  const p = retentionPoliciesSaveSchema.safeParse(await readBody(event))
  if (!p.success) {
    if (p.error.issues.some(i => i.path.includes('keepMonths'))) return apiError(event, 422, 'keep_months_range', 'Від 1 до 120 місяців')
    return apiError(event, 400, 'validation_failed', 'Перевірте політики зберігання')
  }
  const r = await saveRetentionPolicies({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r.ok) {
    if (r.code === 'dry_run_required') return apiError(event, 422, 'dry_run_required', 'Спершу зробіть сухий прогон і підтвердьте обсяг', { origins: r.origins })
    if (r.code === 'evidence_ack_required') return apiError(event, 422, 'evidence_ack_required', 'Підтвердьте, що розумієте: буде видалено підтвердження оцінок', { origins: r.origins })
    return apiError(event, 422, 'keep_months_range', 'Від 1 до 120 місяців', { origins: r.origins })
  }
  return apiData(r.policies)
})
