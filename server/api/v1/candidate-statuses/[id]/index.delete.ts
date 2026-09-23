import { requireScope } from '../../../../services/access'
import { deleteStatus } from '../../../../services/candidateStatuses'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * DELETE /candidate-statuses/:id — удаление своей колонки (docs/v2/28 §3.3, §10,
 * критерий §13 к. 6).
 *
 * `403 status.system` — системную удалить нельзя. `409 candidate_status.in_use` — в колонке
 * стоят кандидаты, и они перечислены в деталях: их нужно перенести, а не потерять с доски.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.status.manage')
  const r = await deleteStatus({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (r.ok) {
    setResponseStatus(event, 204)
    return apiData({ deleted: true })
  }
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Колонку не знайдено')
  if (r.code === 'system_readonly') return apiError(event, 403, 'status.system', 'Системну колонку видалити не можна')
  return apiError(event, 409, 'candidate_status.in_use', 'У колонці є кандидати — спершу перенесіть їх', { candidates: r.candidates })
})
