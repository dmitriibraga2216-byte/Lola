import { z } from 'zod'
import { TASK_TYPES } from '../../../../shared/enums'
import { requireScope } from '../../../services/access'
import { listAssignments } from '../../../services/assignments'
import { apiData, apiError } from '../../../utils/apiResponse'

/** GET /tasks?type=manual|auto|catalog|trajectory|archive — вкладки эталона (docs/04 §4.9). */
const q = z.object({ type: z.enum(TASK_TYPES).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = q.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невідомий тип призначення', { issues: p.error.issues })
  const { type } = p.data
  const filter = type === 'archive' ? { status: 'archived' } : type ? { kind: type } : {}
  return apiData(await listAssignments({ tenantId: a.tenantId, actorId: a.userId }, filter))
})
