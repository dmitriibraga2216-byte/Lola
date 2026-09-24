import { libraryListQuerySchema } from '../../../../../shared/schemas/library'
import { requireScope } from '../../../../services/access'
import { libraryActorOf, listModules } from '../../../../services/library'
import { apiData } from '../../../../utils/apiResponse'
import { libraryValidationFail } from '../../../../utils/libraryErrors'

/**
 * GET /library/modules — «Бібліотека модулів» и палитра вставки (docs/v2/31 §5.1, §5.4, §10).
 * По умолчанию архив скрыт; палитра просит `status=published` — архивного модуля в ней нет
 * (§7.6, критерий приёмки 4). Курсор — по `(updated_at, id)`, новые сверху.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.view')
  const p = libraryListQuerySchema.safeParse(getQuery(event))
  if (!p.success) return libraryValidationFail(event, p.error, 'Перевірте фільтри')
  return apiData(await listModules(libraryActorOf(a), p.data))
})
