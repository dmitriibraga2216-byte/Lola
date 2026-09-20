import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { listLearningRequests } from '../../../../services/learningRequests'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** GET /manage/catalog/requests?kind=tasks|trajectories — «Прийом заявок на навчання» (докс/10 §14.1). */
const q = z.object({ kind: z.enum(['tasks', 'trajectories']).default('tasks') })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = q.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невідома вкладка')
  return apiData(await listLearningRequests({ tenantId: a.tenantId, actorId: a.userId }, p.data.kind))
})
