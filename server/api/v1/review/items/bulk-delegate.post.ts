import { reviewBulkDelegateSchema } from '../../../../../shared/schemas/review'
import { requireScope } from '../../../../services/access'
import { reviewActorOf } from '../../../../services/reviewActor'
import { bulkDelegate } from '../../../../services/reviewDelegation'
import { BULK_DELEGATE_LIMIT } from '../../../../services/reviewRules'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { DELEGATE_ERRORS } from '../../../../utils/reviewErrors'

/**
 * POST /review/items/bulk-delegate — «Делегувати обрані» (docs/v2/37 §5.1, §10): до 25 работ
 * одному делегату. Отказ по одной работе не откатывает остальные — он в `failed` со своим кодом.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.delegate')
  const p = reviewBulkDelegateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Оберіть роботи, кому передати, причину і термін', { issues: p.error.issues })
  const r = await bulkDelegate(reviewActorOf(a), p.data)
  if (!r.ok) return apiError(event, 422, 'review.bulk_limit', `За один раз можна передати до ${BULK_DELEGATE_LIMIT} робіт`)
  return apiData({
    ok: r.delegated,
    failed: r.failed.map(f => ({ id: f.id, code: DELEGATE_ERRORS[f.code][1], message: DELEGATE_ERRORS[f.code][2] })),
  })
})
