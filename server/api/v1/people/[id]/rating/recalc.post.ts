import { requireAccess } from '../../../../../services/access'
import { recalcPersonEngagement } from '../../../../../services/engagementIndex'
import { apiData } from '../../../../../utils/apiResponse'
import { engagementError } from '../../../../../utils/engagementErrors'

/**
 * Пересчитать індекс залученості одного человека (docs/v2/38 §10): тем же расчётом, что ночная
 * `rating.recalc`, в запросе — ответ сразу несёт новый снимок (Р-35.6). Не чаще раза в час —
 * `429 recalc_too_often`; уволенному значение зафиксировано — `409 person_archived`.
 */
export default defineEventHandler(async (event) => {
  const access = await requireAccess(event)
  const r = await recalcPersonEngagement(access, getRouterParam(event, 'id')!)
  return r.ok ? apiData(r.data) : engagementError(event, r.code)
})
