import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { myLearning, myTaskCounts } from '../../../services/learning'
import { apiData } from '../../../utils/apiResponse'

// Пять групп эталона (docs/04 §4.4): ?group=new|planned|failed|overdue|done; старый ?tab= — алиас
const q = z.object({
  group: z.enum(['new', 'planned', 'failed', 'overdue', 'done']).optional(),
  tab: z.enum(['active', 'overdue', 'done']).optional(),
  counts: z.coerce.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'learn.view')
  const { group, tab, counts } = q.parse(getQuery(event))
  const ctx = { tenantId: access.tenantId, actorId: access.userId }
  const g = group ?? (tab === 'done' ? 'done' : tab === 'overdue' ? 'overdue' : 'new')
  const items = await myLearning(ctx, g)
  if (counts) return apiData({ items, counts: await myTaskCounts(ctx) })
  return apiData(items)
})
