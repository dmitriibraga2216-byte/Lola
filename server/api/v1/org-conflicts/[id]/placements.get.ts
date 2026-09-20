import { eq } from 'drizzle-orm'
import { orgConflicts } from '../../../../db/schema'
import { requireScope } from '../../../../services/access'
import { openPlacements } from '../../../../services/journals'
import { withTenant } from '../../../../utils/withTenant'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** GET /org-conflicts/:id/placements — открытые размещения человека из конфликта: что закрыть при «людина у двох підрозділах». */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'people.edit')
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const [c] = await withTenant(ctx.tenantId, ctx.actorId, tx => tx.select({ userId: orgConflicts.userId }).from(orgConflicts).where(eq(orgConflicts.id, getRouterParam(event, 'id')!)))
  if (!c) return apiError(event, 404, 'not_found', 'Конфлікт не знайдено')
  return apiData(c.userId ? await openPlacements(ctx, c.userId) : [])
})
