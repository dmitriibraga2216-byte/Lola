import { translationSchema } from '../../../../../shared/schemas/settings'
import { requireScope } from '../../../../services/access'
import { setTranslation } from '../../../../services/translations'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** PUT /settings/translations {locale, key, value}: переопределение одной строки. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = translationSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте ключ і текст', { issues: p.error.issues })
  return apiData(await setTranslation({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
