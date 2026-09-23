import { requireAnyScope } from '../../../services/access'
import { listStatuses } from '../../../services/candidateStatuses'
import { apiData } from '../../../utils/apiResponse'

/**
 * GET /candidate-statuses — колонки воронки со счётчиком кандидатов (docs/v2/28 §3.3, §5.4, §10).
 *
 * Читать справочник может каждый, кто вообще видит кандидатов: без него карточка не покажет
 * ни статуса, ни цвета. Править — только `candidate.status.manage`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, ['candidate.view', 'candidate.status.manage'])
  const onlyActive = getQuery(event).active === 'true'
  return apiData(await listStatuses({ tenantId: a.tenantId, actorId: a.userId }, { onlyActive }))
})
