import { reviewAbsenceSchema } from '../../../../../shared/schemas/review'
import { requireScope } from '../../../../services/access'
import { reviewActorOf } from '../../../../services/reviewActor'
import { createAbsence } from '../../../../services/reviewWorkload'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { ABSENCE_ERRORS } from '../../../../utils/reviewErrors'

/**
 * POST /review/absences — «Відсутність перевіряючого» (docs/v2/37 §6.2, §7.18, §10). Если
 * отсутствие уже началось, открытые работы переезжают сразу; `movedCount` — сколько.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.absence.manage')
  const p = reviewAbsenceSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Вкажіть тип і дату початку відсутності', { issues: p.error.issues })
  const r = await createAbsence(reviewActorOf(a), p.data)
  if (!r.ok) {
    const [status, code, message] = ABSENCE_ERRORS[r.code]
    return apiError(event, status, code, message)
  }
  return apiData({ absence: { id: r.absenceId }, movedCount: r.movedCount })
})
