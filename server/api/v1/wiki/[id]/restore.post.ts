import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { restoreRevision } from '../../../../services/wiki'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = z.object({ version: z.number().int().min(1) }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть версію')
  const r = await restoreRevision({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.version)
  if (!r) return apiError(event, 404, 'not_found', 'Версію не знайдено')
  if ('forbidden' in r) return apiError(event, 403, 'forbidden', 'Немає права редагувати цю гілку')
  return apiData(r)
})
