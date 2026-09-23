import { requireScope } from '../../../services/access'
import { findDuplicates } from '../../../services/candidates'
import { apiData } from '../../../utils/apiResponse'

/**
 * GET /candidates/duplicates — поиск того же человека по телефону и почте (docs/v2/28 §7.2).
 *
 * Форма зовёт её до сохранения, чтобы показать карточку найденного, а не отказ после отправки
 * (критерий §13 к. 2). Контакты в ответе не отдаются вовсе — только ФИО, вид, состояние и
 * дата: это ПД человека, которого спрашивающий, возможно, видеть не должен.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.edit')
  const q = getQuery(event)
  const rows = await findDuplicates({ tenantId: a.tenantId, actorId: a.userId }, {
    phone: typeof q.phone === 'string' ? q.phone : null,
    email: typeof q.email === 'string' ? q.email : null,
  })
  return apiData(rows)
})
