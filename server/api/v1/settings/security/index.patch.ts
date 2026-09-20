import { securitySettingsSchema } from '../../../../../shared/schemas/reports'
import { requireScope } from '../../../../services/access'
import { updateSecuritySettings } from '../../../../services/securityLog'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** Переключатель «Повідомляти про зміни на E-mail»: письмо администраторам при warning и critical. Смена — событие безопасности. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = securitySettingsSchema.partial().safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля', { issues: p.error.issues })
  return apiData(await updateSecuritySettings({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
