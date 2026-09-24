import { requireScope } from '../../../../../../services/access'
import { getVersion, libraryActorOf } from '../../../../../../services/library'
import { apiData } from '../../../../../../utils/apiResponse'
import { libraryFail } from '../../../../../../utils/libraryErrors'

/**
 * GET /library/modules/:id/versions/:version — тело закреплённой версии (docs/v2/31 §7.2).
 * Этим читает своё тело место использования на v2, когда уже вышла v3 (критерий приёмки 1),
 * и «Порівняти з v3» на вкладке «Версії» (§5.2). Дополняет §10: там версии только списком.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.view')
  const n = Number(getRouterParam(event, 'version'))
  if (!Number.isInteger(n) || n < 1) return libraryFail(event, 'not_found')
  const v = await getVersion(libraryActorOf(a), getRouterParam(event, 'id')!, n)
  if (!v) return libraryFail(event, 'not_found', undefined, 'Версію не знайдено')
  return apiData(v)
})
