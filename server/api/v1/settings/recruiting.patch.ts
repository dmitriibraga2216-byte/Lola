import { recruitingPatchSchema } from '../../../../shared/schemas/settings'
import { requireScope } from '../../../services/access'
import { updateRecruiting } from '../../../services/settings'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * PATCH /settings/recruiting — включение рекрутинга тенанту и его сроки (docs/v2/28 §7.5, §7.9).
 * Флаг живёт в колонке `tenants.candidates_enabled`, сроки — в настройках; одна ручка, два
 * носителя, каждый остаётся единственным источником своей правды.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = recruitingPatchSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте значення', { issues: p.error.issues })
  return apiData(await updateRecruiting({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
