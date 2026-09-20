import { requireScope } from '../../../../services/access'
import { updateDevelopmentSettings } from '../../../../services/developmentExtra'
import { developmentSettingsPatchSchema } from '../../../../../shared/schemas/development'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** Настройки модуля розвитку (docs/19 §7.4, §7.7, §7.9, §14.1 «Шкала компетенцій»). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = developmentSettingsPatchSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля', { issues: p.error.issues })
  return apiData(await updateDevelopmentSettings({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
