import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { registerForEvent } from '../../../../services/hubExtra'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** POST /events/:id/register {guestsCount} — запись на событие (docs/21 §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = z.object({ guestsCount: z.number().int().min(0).max(10).default(0) }).safeParse((await readBody(event)) ?? {})
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Гостей — від 0 до 10')
  const r = await registerForEvent({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.guestsCount)
  if (!r.ok) return apiError(event, r.code === 'not_found' ? 404 : 422, `event.${r.code}`, r.code === 'not_found' ? 'Подію не знайдено' : r.code === 'already' ? 'Ви вже записані' : r.code === 'closed' ? 'Запис закрито' : 'Місць немає')
  return apiData(r)
})
