import { translationsImportSchema } from '../../../../../shared/schemas/settings'
import { requireScope } from '../../../../services/access'
import { importTranslations } from '../../../../services/translations'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** POST /settings/translations/import {locale, items}: ключи вне словаря пропускаются. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = translationsImportSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Очікується json {ключ: текст}', { issues: p.error.issues })
  return apiData(await importTranslations({ tenantId: a.tenantId, actorId: a.userId }, p.data.locale, p.data.items))
})
