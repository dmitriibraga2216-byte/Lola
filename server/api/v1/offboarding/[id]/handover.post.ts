import { offboardingHandoverSchema } from '../../../../../shared/schemas/offboarding'
import { requireScope } from '../../../../services/access'
import { markHandoverDone } from '../../../../services/offboarding'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /offboarding/:id/handover — передача дел закрыта (docs/v2/33 §4.2, переход
 * `handover → interview`).
 *
 * Путь сверх таблицы §10: сам переход документ называет автоматическим («чек-лист закрыт»),
 * но чек-лист передачи дел как объект (`docs/20`) к офбордингу ещё не привязан, и факт
 * закрытия системе должен кто-то сообщить. Решение и срок — `docs/28` §28.13.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'offboarding.start')
  const p = offboardingHandoverSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Підтвердіть передачу справ', { issues: p.error.issues })
  const r = await markHandoverDone({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (r === 'not_found') return apiError(event, 404, 'not_found', 'Звільнення не знайдено')
  if (r === 'bad_state') return apiError(event, 409, 'offboarding.completed', 'Звільнення вже завершено або скасовано')
  return apiData(r)
})
