import { requireScope } from '../../../../../services/access'
import { viewerOf } from '../../../../../services/candidates'
import { cancelAutoSend } from '../../../../../services/candidateSummaries'
import { apiError } from '../../../../../utils/apiResponse'

/**
 * POST /candidate-summaries/:id/auto-send/cancel — «Скасувати автоматичне надсилання» до
 * `auto_send_due_at` (`docs/v2/30` §7.15, §8 «Можна скасувати», §13 к. 13; `summary.send`): `204`.
 * Сверка авто-отправки этот документ заново не ставит.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'summary.send')
  const r = await cancelAutoSend(viewerOf(a), getRouterParam(event, 'id')!)
  if (r.ok) {
    setResponseStatus(event, 204)
    return null
  }
  if (r.code === 'not_scheduled') return apiError(event, 409, 'summary.auto_send_not_scheduled', 'Автоматичне надсилання не заплановано або вже відбулося')
  return apiError(event, 404, 'not_found', 'Підсумок не знайдено')
})
