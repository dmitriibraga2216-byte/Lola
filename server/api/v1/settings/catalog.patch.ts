import { catalogSettingsSchema } from '../../../../shared/schemas/catalog'
import { requireScope } from '../../../services/access'
import { updateCatalogSettings } from '../../../services/catalogAccess'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = catalogSettingsSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте значення')
  return apiData(await updateCatalogSettings({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
