import { requireScope } from '../../../../../services/access'
import { deleteModule, libraryActorOf } from '../../../../../services/library'
import { apiData } from '../../../../../utils/apiResponse'
import { libraryFail } from '../../../../../utils/libraryErrors'

/**
 * DELETE /library/modules/:id — физическое удаление (docs/v2/31 §7.5, Р-31.3, §10).
 *
 * Используемый модуль не удаляется: `409 library_module.in_use` со списком мест (до 50 плюс
 * общее число) и предложением «Заархівувати» (`details.suggest = 'archive'`) — критерий
 * приёмки 3 и условие выхода PR-25. Удаление — право `library.manage` (§2: только admin).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.manage')
  const r = await deleteModule(libraryActorOf(a), getRouterParam(event, 'id')!)
  if (r.ok) {
    setResponseStatus(event, 204)
    return apiData({ deleted: true })
  }
  if (r.code !== 'in_use') return libraryFail(event, r.code)
  const message = r.reason === 'active_usages'
    ? `Модуль використовується у ${r.total} місцях. Видалити не можна — його можна заархівувати`
    : r.reason === 'detached_usages'
      ? 'Модуль уже використовувався, історію місць треба зберегти. Видалити не можна — його можна заархівувати'
      : 'У модуля кілька версій, їхню історію треба зберегти. Видалити не можна — його можна заархівувати'
  return libraryFail(event, 'in_use', {
    reason: r.reason,
    usages: r.usages,
    total: r.total,
    detached: r.detached,
    versions: r.versions,
    suggest: 'archive',
  }, message)
})
