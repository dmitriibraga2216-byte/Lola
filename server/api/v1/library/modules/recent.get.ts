import { requireScope } from '../../../../services/access'
import { libraryActorOf, recentModules } from '../../../../services/library'
import { apiData } from '../../../../utils/apiResponse'

/**
 * GET /library/modules/recent — «до 8 последних использованных модулей» палитры вставки
 * (docs/v2/31 §5.4): сначала вставленные самим автором, затем — коллегами; только
 * опубликованные (архивного модуля в палитре нет, §7.6, критерий 4). Дополняет §10.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.view')
  return apiData(await recentModules(libraryActorOf(a)))
})
