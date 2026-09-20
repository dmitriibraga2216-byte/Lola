import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { exportTranslations } from '../../../../services/translations'
import { apiError } from '../../../../utils/apiResponse'
/** GET /settings/translations/export?locale= — json своих текстов. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = z.enum(['uk', 'en']).safeParse(getQuery(event).locale ?? 'uk')
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть мову')
  const data = await exportTranslations({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  setHeader(event, 'Content-Type', 'application/json; charset=utf-8')
  setHeader(event, 'Content-Disposition', `attachment; filename="translations-${p.data}.json"`)
  return JSON.stringify(data, null, 2)
})
