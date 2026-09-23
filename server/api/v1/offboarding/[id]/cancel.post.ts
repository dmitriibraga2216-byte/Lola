import { offboardingCancelSchema } from '../../../../../shared/schemas/offboarding'
import { requireScope } from '../../../../services/access'
import { cancelOffboarding } from '../../../../services/offboarding'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /offboarding/:id/cancel — отмена (docs/v2/33 §4.2, §12.3, §10): человек остаётся,
 * этап возвращается к прежнему, назначения офбординга снимаются. После `done` отмены нет —
 * только повторный найм (§7.8), `409 offboarding.completed`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'offboarding.start')
  const p = offboardingCancelSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Вкажіть причину скасування', { issues: p.error.issues })
  const r = await cancelOffboarding({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.reasonText)
  if (r === 'not_found') return apiError(event, 404, 'not_found', 'Звільнення не знайдено')
  if (r === 'completed') return apiError(event, 409, 'offboarding.completed', 'Звільнення завершено — поверніть людину повторним наймом')
  return apiData(r)
})
