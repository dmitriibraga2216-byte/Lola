import { z } from 'zod'
import { requireAnyScope } from '../../../services/access'
import { listAccessGroups } from '../../../services/resources'
import { apiData, apiError } from '../../../utils/apiResponse'

/** Группы доступа базы знаний и каталога (docs/21 §14.1, docs/10 §14.1, docs/02 access_groups). */
// v2-allow: check1 — 'knowledge' тут код модуля «база знань», не код этапа lifecycle_stages
const q = z.object({ appliesTo: z.enum(['knowledge', 'catalog']).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, ['course.view', 'assignment.create'])
  const p = q.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невідома область групи')
  return apiData(await listAccessGroups({ tenantId: a.tenantId, actorId: a.userId }, p.data.appliesTo))
})
