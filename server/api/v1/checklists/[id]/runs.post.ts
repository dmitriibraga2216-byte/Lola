import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { startRun } from '../../../../services/checklists'
import { apiData, apiError } from '../../../../utils/apiResponse'
const schema = z.object({ locationId: z.string().uuid().optional(), subjectUserId: z.string().uuid().optional(), startedAt: z.string().datetime({ offset: true }).optional(), device: z.string().max(200).optional(), geo: z.object({ lat: z.number(), lng: z.number() }).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'checklist.run')
  const p = schema.safeParse(await readBody(event) ?? {})
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте параметри прогону')
  const r = await startRun({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  // Чек-лист вимкнено або людини, про яку прогін, немає в просторі (чужий тенант — теж 404, п. 15)
  if (!r) return apiError(event, 404, 'not_found', p.data.subjectUserId ? 'Чек-лист або людину, про яку прогін, не знайдено' : 'Чек-лист не знайдено або вимкнено')
  return apiData(r)
})
