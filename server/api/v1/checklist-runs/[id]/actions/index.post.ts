import { z } from 'zod'
import { areaCovers, areaOf, hasTenantGrant, requireScope } from '../../../../../services/access'
import { addAction, type RunGuard } from '../../../../../services/checklists'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'checklist.run')
  const p = z.object({ text: z.string().min(1).max(500), responsibleId: z.string().uuid(), dueAt: z.string().date() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Пункт плану: текст, відповідальний, термін')
  const area = await areaOf(a, 'checklist.run')
  const guard: RunGuard = run => run.observerId === a.userId || hasTenantGrant(a, 'checklist.manage') || areaCovers(area, run.locationId)
  const r = await addAction({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data, guard)
  if (!r) return apiError(event, 404, 'not_found', 'Прогін не знайдено')
  return apiData(r)
})
