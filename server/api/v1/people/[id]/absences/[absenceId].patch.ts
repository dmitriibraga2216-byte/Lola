import { absenceRecordUpdateSchema } from '../../../../../../shared/schemas/absences'
import { requireAccess } from '../../../../../services/access'
import { absenceViewerOf, updateAbsenceRecord } from '../../../../../services/absences'
import { apiError } from '../../../../../utils/apiResponse'
import { absenceWriteError } from '../../../../../utils/absenceErrors'

/**
 * Правка записи отсутствия (docs/v2/38 §4, §10): вид, период, коментар, статус — только вперёд
 * (`planned → approved → cancelled`, иначе `409 absence_status_invalid`); отменённую не правят —
 * `409 absence_cancelled`. Отмена сдвинутые сроки назад не возвращает.
 */
export default defineEventHandler(async (event) => {
  const access = await requireAccess(event)
  const parsed = absenceRecordUpdateSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    return apiError(event, 400, 'validation_failed', 'Перевірте вид, період, статус і коментар відсутності', { field: String(parsed.error.issues[0]?.path[0] ?? ''), issues: parsed.error.issues })
  }
  const r = await updateAbsenceRecord({ tenantId: access.tenantId, actorId: access.userId }, await absenceViewerOf(access), getRouterParam(event, 'id')!, getRouterParam(event, 'absenceId')!, parsed.data)
  if (!r.ok) return absenceWriteError(event, r)
  return { data: r.record, meta: { shifted: r.shifted } }
})
