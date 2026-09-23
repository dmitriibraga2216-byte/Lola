import { requireScope } from '../../../services/access'
import { offboardingStage } from '../../../services/offboarding'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * GET /offboarding/stage — этап «Офбординг» и его курсы для формы запуска (docs/v2/33 §6.2:
 * поле «Курси офбордингу» предзаполняется курсами этапа). Состав решает сервер — клиент
 * не знает ни кодов этапов, ни правил их выбора (§7.1, CLAUDE.md п. 3).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'offboarding.start')
  const r = await offboardingStage({ tenantId: a.tenantId, actorId: a.userId })
  if (!r) return apiError(event, 404, 'not_found', 'Етап «Офбординг» не налаштовано')
  return apiData(r)
})
