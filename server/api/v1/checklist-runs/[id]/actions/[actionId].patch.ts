import { z } from 'zod'
import { areaCovers, areaOf, hasTenantGrant, requireScope } from '../../../../../services/access'
import { updateAction, type RunGuard } from '../../../../../services/checklists'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'checklist.run')
  const p = z.object({ status: z.enum(['open', 'done']).optional(), text: z.string().min(1).max(500).optional(), dueAt: z.string().date().optional(), responsibleId: z.string().uuid().optional() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте пункт плану')
  const area = await areaOf(a, 'checklist.run')
  const guard: RunGuard = (run, responsibleId) => run.observerId === a.userId || responsibleId === a.userId || hasTenantGrant(a, 'checklist.manage') || areaCovers(area, run.locationId)
  const r = await updateAction({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, getRouterParam(event, 'actionId')!, p.data, guard)
  if (!r) return apiError(event, 404, 'not_found', 'Пункт не знайдено')
  return apiData(r)
})
