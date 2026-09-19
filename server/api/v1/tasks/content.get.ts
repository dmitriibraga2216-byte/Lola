import { z } from 'zod'
import { CONTENT_TYPES } from '../../../../shared/enums'
import { requireScope } from '../../../services/access'
import { listContent } from '../../../services/taskContent'
import { apiData } from '../../../utils/apiResponse'

/** GET /tasks/content?type= — «Обрати з існуючих»: назначаемый контент типа (docs/15 §14.2). */
const q = z.object({ type: z.enum(CONTENT_TYPES), q: z.string().max(100).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const { type, q: search } = q.parse(getQuery(event))
  return apiData(await listContent({ tenantId: a.tenantId, actorId: a.userId }, type, search))
})
