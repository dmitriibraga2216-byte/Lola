import { requireScope } from '../../../../../services/access'
import { getModule, libraryActorOf } from '../../../../../services/library'
import { apiData } from '../../../../../utils/apiResponse'
import { libraryFail } from '../../../../../utils/libraryErrors'

/**
 * GET /library/modules/:id — карточка + текущая версия + число мест (docs/v2/31 §5.2, §10).
 * Модуль чужого тенанта под RLS не находится — `404`, не `403` (критерий приёмки 9).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.view')
  const m = await getModule(libraryActorOf(a), getRouterParam(event, 'id')!)
  if (!m) return libraryFail(event, 'not_found')
  return apiData(m)
})
