import { requireAnyScope } from '../../../../../services/access'
import { libraryActorOf, restoreModule } from '../../../../../services/library'
import { apiData } from '../../../../../utils/apiResponse'
import { libraryFail } from '../../../../../utils/libraryErrors'

/**
 * POST /library/modules/:id/restore — из архива (docs/v2/31 §4, §10): модуль с версиями
 * возвращается в `published`, заархивированный из черновика — в `draft`. Физически удалённый
 * модуль не находится — `404` (удаление физическое, `409 module_deleted` из §10 не возникает).
 */
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, ['library.publish', 'library.manage'])
  const r = await restoreModule(libraryActorOf(a), getRouterParam(event, 'id')!)
  if (!r.ok) return libraryFail(event, r.code === 'not_archived' ? 'module_not_archived' : r.code, r.code === 'forbidden' ? { reason: 'not_author' } : undefined)
  return apiData(r.module)
})
