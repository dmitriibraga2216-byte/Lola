import { requireAccess } from '../../../../../services/access'
import { personEngagement } from '../../../../../services/engagementIndex'
import { apiData } from '../../../../../utils/apiResponse'
import { engagementError } from '../../../../../utils/engagementErrors'

/**
 * «Звідки взявся мій відсоток» (docs/v2/38 §5.3, §10): індекс залученості человека — итог, четыре
 * слагаемых с числами формулы, окно, динамика за 12 месяцев. **Не баллы рейтинга** (`points_ledger`).
 * Скоупа на входе нет: свой индекс видит каждый сотрудник, чужой — носитель
 * `person.rating.view_others` в области текущей точки человека; права решает сервис.
 * Кандидат, чужой тенант, не-uuid — `404`.
 */
export default defineEventHandler(async (event) => {
  const access = await requireAccess(event)
  const r = await personEngagement(access, getRouterParam(event, 'id')!)
  return r.ok ? apiData(r.data) : engagementError(event, r.code)
})
