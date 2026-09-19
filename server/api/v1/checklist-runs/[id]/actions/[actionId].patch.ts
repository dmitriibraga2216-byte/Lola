import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { updateAction } from '../../../../../services/checklists'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'checklist.run')
  const p = z.object({ status: z.enum(['open', 'done']).optional(), text: z.string().min(1).max(500).optional(), dueAt: z.string().date().optional(), responsibleId: z.string().uuid().optional() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте пункт плану')
  const r = await updateAction({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, getRouterParam(event, 'actionId')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Пункт не знайдено')
  return apiData(r)
})
