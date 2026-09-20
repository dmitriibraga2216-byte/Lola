import { emailLayoutPatchSchema } from '../../../../../shared/schemas/settings'
import { requireScope } from '../../../../services/access'
import { updateEmailLayout } from '../../../../services/settings'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** PUT /settings/email-layout: спільна обвʼязка листа (шапка/підвал) для всіх шаблонів тенанта (docs/23 §13.5). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = emailLayoutPatchSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте значення', { issues: p.error.issues })
  return apiData(await updateEmailLayout({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
