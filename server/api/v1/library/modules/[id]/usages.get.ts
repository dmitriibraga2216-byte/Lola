import { libraryUsagesQuerySchema } from '../../../../../../shared/schemas/library'
import { requireScope } from '../../../../../services/access'
import { libraryActorOf } from '../../../../../services/library'
import { listUsages } from '../../../../../services/libraryUsages'
import { apiData } from '../../../../../utils/apiResponse'
import { libraryFail, libraryValidationFail } from '../../../../../utils/libraryErrors'

/**
 * GET /library/modules/:id/usages — «Де використовується» (docs/v2/31 §5.3, §10): место, его
 * закреплённая версия, признак «застаріло» и последняя версия модуля (баннер «Доступна нова
 * версія», критерий приёмки 1). `includeDetached=true` — плюс «Відключені раніше».
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.view')
  const p = libraryUsagesQuerySchema.safeParse(getQuery(event))
  if (!p.success) return libraryValidationFail(event, p.error)
  const r = await listUsages(libraryActorOf(a), getRouterParam(event, 'id')!, { includeDetached: p.data.includeDetached })
  if (!r) return libraryFail(event, 'not_found')
  return apiData(r)
})
