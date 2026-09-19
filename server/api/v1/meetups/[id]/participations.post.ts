import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { recordParticipation } from '../../../../services/meetups'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** Участие в вебинаре: от провайдера (через API-токен) или вручную тренером (docs/18 §7.6). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.attendance')
  const p = z.object({ source: z.enum(['provider', 'manual']).default('manual'), rows: z.array(z.object({ userId: z.string().uuid(), minutes: z.number().int().min(0).max(1440), joinedAt: z.string().datetime({ offset: true }).optional(), leftAt: z.string().datetime({ offset: true }).optional() })).min(1).max(1000) }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте дані участі')
  const r = await recordParticipation({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.rows, p.data.source)
  if (!r) return apiError(event, 404, 'not_found', 'Вебінар не знайдено')
  return apiData(r)
})
