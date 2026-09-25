import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { getOrgImport } from '../../../../services/orgImport'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** GET /org-structure/import/:id — предпросмотр и ход применения (экран опрашивает статус). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'org.structure.import')
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  const view = id.success ? await getOrgImport({ tenantId: a.tenantId, actorId: a.userId }, id.data) : null
  if (!view) return apiError(event, 404, 'not_found', 'Імпорт не знайдено')
  return apiData(view)
})
