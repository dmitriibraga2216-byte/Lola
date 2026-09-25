import { requireScope } from '../../../services/access'
import { listScenarios } from '../../../services/interview/scenarios'
import { interviewScenarioListSchema } from '../../../../shared/schemas/interview'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * GET /interview-scenarios — сценарии собеседования (`docs/v2/30` §5.6, §10; `interview.configure`):
 * название, модуль, версия, критериев, проведено собеседований, доля `needs_human`. Ключевой
 * курсор (`docs/04` §4.1); битый курсор или фильтр — `400`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'interview.configure')
  const q = interviewScenarioListSchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', q.error.issues[0]?.message ?? 'Некоректні параметри фільтра', { issues: q.error.issues })
  return apiData(await listScenarios({ tenantId: a.tenantId, actorId: a.userId }, q.data))
})
