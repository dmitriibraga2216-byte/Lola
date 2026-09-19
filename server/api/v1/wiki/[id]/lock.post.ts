import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { lockPage } from '../../../../services/wiki'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** Блокировка страницы на время правки (docs/21 §5.5): 15 минут, {release:true} — снять. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'wiki.edit')
  const p = z.object({ release: z.boolean().optional() }).safeParse(await readBody(event) ?? {})
  const r = await lockPage({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.success ? p.data.release : false)
  if (!r) return apiError(event, 404, 'not_found', 'Сторінку не знайдено')
  if (!r.ok) return apiError(event, 409, 'wiki.locked', `Сторінку редагує ${r.lockedByName}`, { until: r.until })
  return apiData(r)
})
