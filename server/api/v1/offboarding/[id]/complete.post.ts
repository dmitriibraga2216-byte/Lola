import { offboardingCompleteSchema } from '../../../../../shared/schemas/offboarding'
import { requireScope } from '../../../../services/access'
import { completeOffboarding } from '../../../../services/offboarding'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /offboarding/:id/complete — завершение (docs/v2/33 §7.7, §10; критерий §13 п. 9).
 *
 * Завершать вправе только `offboarding.complete` (§2 — HR/администратор, не керівник точки):
 * операция закрывает доступ и освобождает лимит. До последнего рабочего дня — `409
 * offboarding.before_last_day`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'offboarding.complete')
  const p = offboardingCompleteSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Підтвердіть завершення звільнення', { issues: p.error.issues })
  const r = await completeOffboarding({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (r === 'not_found') return apiError(event, 404, 'not_found', 'Звільнення не знайдено')
  if (r === 'bad_state') return apiError(event, 409, 'offboarding.completed', 'Звільнення вже завершено або скасовано')
  if (r === 'before_last_day') return apiError(event, 409, 'offboarding.before_last_day', 'Останній робочий день ще не настав')
  if (r === 'last_admin') return apiError(event, 409, 'people.last_admin', 'Це останній адміністратор простору — спершу призначте іншого')
  return apiData(r)
})
