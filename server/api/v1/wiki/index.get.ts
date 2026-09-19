import { z } from 'zod'
import { requireScope, can } from '../../../services/access'
import { searchWiki, wikiTree } from '../../../services/wiki'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const q = z.object({ q: z.string().optional(), all: z.coerce.boolean().optional() }).parse(getQuery(event))
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  if (q.q) return apiData(await searchWiki(ctx, q.q))
  return apiData(await wikiTree(ctx, { all: q.all && can(a, 'wiki.edit') }))
})
