import { conflictListQuerySchema } from '../../../../shared/schemas/people'
import { can, requireScope } from '../../../services/access'
import { readLog } from '../../../services/logs'
import { apiData, apiError } from '../../../utils/apiResponse'

/** GET /org-conflicts (docs/04 §4.11): протокол конфликтов оргструктуры, по умолчанию — невирішені. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'people.edit')
  const q = conflictListQuerySchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри', { issues: q.error.issues })
  // Кандидат в строке — только смотрящему с candidate.view (docs/28 §28.9.1 п.1, решение владельца 25.09)
  const ctx = { tenantId: a.tenantId, actorId: a.userId, canSeeCandidates: can(a, 'candidate.view') }
  const rows = await readLog(ctx, 'org-conflicts', { state: q.data.state, type: q.data.kind, from: q.data.from, to: q.data.to, userId: q.data.userId, limit: q.data.limit })
  return apiData({ rows })
})
