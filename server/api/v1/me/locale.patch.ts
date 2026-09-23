import { meLocaleSchema } from '../../../../shared/schemas/hub'
import { requireScope } from '../../../services/access'
import { setLocale } from '../../../services/hubPeople'
import { apiData, apiError } from '../../../utils/apiResponse'

/** PATCH /me/locale — своя мова інтерфейсу (докс/24 §3.6, «Профіль»); null — успадкувати мову тенанта. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = meLocaleSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте значення')
  return apiData(await setLocale({ tenantId: a.tenantId, actorId: a.userId }, p.data.locale))
})
