import { aiSettingsPatchSchema } from '../../../../shared/schemas/settings'
import { requireScope } from '../../../services/access'
import { updateAiSettings } from '../../../services/settings'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * PATCH /settings/ai — включить или выключить функцию ИИ (`docs/v2/30` §5.6, §7.13; `ai.audit`).
 * Включение подсказки — решение отправлять ответы людей модели: пишется и в журнал безопасности.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'ai.audit')
  const p = aiSettingsPatchSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте значення', { issues: p.error.issues })
  return apiData(await updateAiSettings({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
