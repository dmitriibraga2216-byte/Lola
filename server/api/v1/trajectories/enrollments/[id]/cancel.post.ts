import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { cancelTrajectoryEnrollment } from '../../../../../services/trajectories'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = z.object({ reason: z.string().min(2, 'Вкажіть причину').max(300) }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Вкажіть причину')
  const ok = await cancelTrajectoryEnrollment(a.tenantId, getRouterParam(event, 'id')!, { actorId: a.userId, reason: p.data.reason })
  if (!ok) return apiError(event, 404, 'not_found', 'Прохождення не знайдено або вже завершене')
  return apiData({ ok: true })
})
