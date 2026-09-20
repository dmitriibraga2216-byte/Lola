import { requireScope } from '../../../services/access'
import { getCatalogSettings } from '../../../services/catalogAccess'
import { apiData } from '../../../utils/apiResponse'

/** GET /settings/catalog — «Використовувати обмеження доступу до завдань в каталозі навчання» (docs/10 §14.1). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  return apiData(await getCatalogSettings({ tenantId: a.tenantId, actorId: a.userId }))
})
