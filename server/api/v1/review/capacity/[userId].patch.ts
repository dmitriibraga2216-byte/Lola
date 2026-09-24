import { reviewCapacitySchema } from '../../../../../shared/schemas/review'
import { requireScope } from '../../../../services/access'
import { reviewActorOf } from '../../../../services/reviewActor'
import { updateCapacity } from '../../../../services/reviewWorkload'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * PATCH /review/capacity/:userId — «Змінити ліміт» (docs/v2/37 §5.3) и «приймаю делегування»
 * (§7.2 (д)). Своё «приймаю» меняет сам проверяющий; лимиты и виды работ — руководитель.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.queue')
  const p = reviewCapacitySchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Ліміт — від 1 до 200 робіт', { issues: p.error.issues })
  const r = await updateCapacity(reviewActorOf(a), getRouterParam(event, 'userId')!, p.data)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Людину не знайдено')
    return apiError(event, 403, 'forbidden', 'Ліміт змінює керівник; собі можна лише ввімкнути чи вимкнути делегування')
  }
  return apiData({ ok: true })
})
