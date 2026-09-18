import { requireScope } from '../../../../../services/access'
import { applyImport } from '../../../../../services/importPeople'
import { apiData, apiError } from '../../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.import')
  const result = await applyImport(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
  )
  if (!result) return apiError(event, 409, 'conflict', 'Імпорт не готовий до застосування')
  return apiData(result)
})
