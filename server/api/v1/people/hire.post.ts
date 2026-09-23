import { hireSchema } from '../../../../shared/schemas/offboarding'
import { requireScope } from '../../../services/access'
import { hire } from '../../../services/offboarding'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * POST /people/hire — найм и **повторный** найм (docs/v2/33 §7.8, критерий §13 п. 10).
 *
 * Одна ручка на оба случая намеренно: только так гарантируется инвариант пакета — повторный
 * найм того же человека не создаёт вторую запись `users`. Отдельная «ручка повторного найма»
 * означала бы, что обычный найм по-прежнему волен завести дубль.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'people.invite')
  const p = hireSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте дані найму', { issues: p.error.issues })
  const r = await hire({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (r === 'place_not_found') return apiError(event, 404, 'not_found', 'Точку або посаду не знайдено')
  if (r === 'needs_name') return apiError(event, 422, 'validation_failed', 'Вкажіть ПІБ — такої людини ще немає')
  if (r === 'offboarding_active') return apiError(event, 409, 'offboarding.active_exists', 'У людини триває звільнення — спершу завершіть або скасуйте його')
  if (r === 'stage_missing') return apiError(event, 409, 'lifecycle.disabled', 'Етап «Онбординг» не налаштовано')
  return apiData(r)
})
