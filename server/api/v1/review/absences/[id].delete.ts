import { requireScope } from '../../../../services/access'
import { reviewActorOf } from '../../../../services/reviewActor'
import { deleteAbsence } from '../../../../services/reviewWorkload'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { ABSENCE_ERRORS } from '../../../../utils/reviewErrors'

/** DELETE /review/absences/:id — отменить отсутствие (docs/v2/37 §10). Переехавшие работы назад не едут. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.absence.manage')
  const r = await deleteAbsence(reviewActorOf(a), getRouterParam(event, 'id')!)
  if (!r.ok) {
    const [status, code, message] = ABSENCE_ERRORS[r.code]
    return apiError(event, status, code, message)
  }
  return apiData({ ok: true })
})
