import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { rateMentor } from '../../../../../services/workshops'
import { apiData, apiError } from '../../../../../utils/apiResponse'
/** Оценка наставника учеником после проверки (docs/22 §4.5, Б.7): 1–5, один раз. `id` — сдача. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = z.object({ rating: z.number().int().min(1).max(5) }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Оцінка від 1 до 5')
  const ok = await rateMentor({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.rating)
  if (!ok) return apiError(event, 409, 'already', 'Оцінку вже поставлено або перевірка ще не завершена')
  return apiData({ ok: true })
})
