import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { addAction } from '../../../../../services/checklists'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'checklist.run')
  const p = z.object({ text: z.string().min(1).max(500), responsibleId: z.string().uuid(), dueAt: z.string().date() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Пункт плану: текст, відповідальний, термін')
  const r = await addAction({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Прогін не знайдено')
  return apiData(r)
})
