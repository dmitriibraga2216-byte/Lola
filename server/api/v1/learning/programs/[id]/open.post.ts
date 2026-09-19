import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { openNode } from '../../../../../services/programs'
import { apiData, apiError } from '../../../../../utils/apiResponse'
/** Открыть шаг: :id — program_enrollment, body.nodeId. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = z.object({ nodeId: z.string().uuid() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть крок')
  const r = await openNode({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.nodeId)
  if (!r.ok) return apiError(event, r.code === 'not_found' ? 404 : 409, `program.${r.code}`, r.code === 'locked' ? 'Цей крок ще закритий' : 'Не знайдено')
  return apiData(r)
})
