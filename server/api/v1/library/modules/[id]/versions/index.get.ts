import { requireScope } from '../../../../../../services/access'
import { libraryActorOf, listVersions } from '../../../../../../services/library'
import { apiData } from '../../../../../../utils/apiResponse'
import { libraryFail } from '../../../../../../utils/libraryErrors'

/** GET /library/modules/:id/versions — вкладка «Версії» (docs/v2/31 §5.2, §10): changelog, «Критичне виправлення», сколько мест на версии. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.view')
  const rows = await listVersions(libraryActorOf(a), getRouterParam(event, 'id')!)
  if (!rows) return libraryFail(event, 'not_found')
  return apiData(rows)
})
