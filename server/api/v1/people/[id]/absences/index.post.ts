import { absenceRecordCreateSchema } from '../../../../../../shared/schemas/absences'
import { requireAccess } from '../../../../../services/access'
import { absenceViewerOf, createAbsenceRecord } from '../../../../../services/absences'
import { apiError } from '../../../../../utils/apiResponse'
import { absenceWriteError } from '../../../../../utils/absenceErrors'

/**
 * «Внести відсутність» (docs/v2/38 §6.4, §10): `{kind, dateFrom, dateTo, status, comment?}`.
 * Пересечение с действующей записью — `409 absence_overlap`; период наоборот или длиннее года —
 * `422 absence_record.range_invalid`. Сроки обязательных назначений, на которые легло отсутствие,
 * сдвигаются в той же транзакции (§7.14) — `meta.shifted` говорит, сколько.
 */
export default defineEventHandler(async (event) => {
  const access = await requireAccess(event)
  const parsed = absenceRecordCreateSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    return apiError(event, 400, 'validation_failed', 'Оберіть вид, період і статус відсутності; коментар — до 300 знаків', { field: String(parsed.error.issues[0]?.path[0] ?? ''), issues: parsed.error.issues })
  }
  const r = await createAbsenceRecord({ tenantId: access.tenantId, actorId: access.userId }, await absenceViewerOf(access), getRouterParam(event, 'id')!, parsed.data)
  if (!r.ok) return absenceWriteError(event, r)
  setResponseStatus(event, 201)
  return { data: r.record, meta: { shifted: r.shifted } }
})
